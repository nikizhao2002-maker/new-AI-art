/**
 * 统一手势输入总线 (hand-input.js)
 * ------------------------------------------------------------------
 * 目标：全应用只开「一路摄像头」+「一个 HandLandmarker」，把手势数据
 *       同时供给主程序的阶段逻辑与可嵌入的粒子场景，消除原先
 *       主程序(旧 @mediapipe/hands Solutions API) 与 pointcloud-demo
 *       (新 tasks-vision) 各开一路摄像头导致的冲突 (NotReadableError)。
 *
 * 设计：内部用新版 tasks-vision HandLandmarker.detectForVideo()，并把
 *       结果整形成与旧版 Hands.onResults 兼容的对象
 *       ({ multiHandLandmarks, multiHandedness, image })，这样主程序里
 *       那段已调好的五阶段手势解析逻辑无需改动即可继续工作。
 *
 * 同时维护一个归一化的 handData 单例，供粒子场景等新模块按需直接读取。
 */

import {
    FilesetResolver,
    HandLandmarker,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs';

const TASKS_VISION_WASM =
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
// 本地优先：storage.googleapis.com 在国内常被墙/极慢，会导致手势识别整体失败
//（表现为「张手也没有任何反应、没有粒子」）。模型已随包附带在 assets/mediapipe/。
const HAND_MODEL_LOCAL = new URL('assets/mediapipe/hand_landmarker.task', document.baseURI).href;
const HAND_MODEL_REMOTE =
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/** 归一化手势数据单例：所有消费方共享读取（坐标已做镜像，便于场景使用） */
export const handData = {
    detected: false,
    twoHands: false,
    palmX: 0,        // [-1,1]，已镜像（右手在右）
    palmY: 0,        // [-1,1]，向上为正
    fingersUp: 0,
    openness: 0,     // 0(握拳)~1(张开)
    pinch: 0,        // 拇指-食指距离（归一化）
    landmarks: null, // 主手 21 点原始数据
};

let _landmarker = null;
let _video = null;
let _stream = null;
let _running = false;
let _rafId = null;
let _onResults = null;
let _lastTs = 0;
let _minInterval = 1000 / 30;

/** 主手张开度：指尖到手腕的平均距离 / 手掌尺寸，映射到 0~1 */
// 与 pointcloud-demo 完全一致：五指「指尖→指根」距离之和 / 手掌大小，
// 求和范围约 握拳1.2 ~ 张开5.0，映射 (sum-1.2)/2.3 → 0~1（张开可达 1.0，能完全散成粒子）
function calcOpenness(lm) {
    const wrist = lm[0];
    const palm = lm[9];
    const palmSize = Math.hypot(palm.x - wrist.x, palm.y - wrist.y, (palm.z || 0) - (wrist.z || 0));
    if (palmSize < 0.001) return 0;
    const pairs = [[4, 2], [8, 5], [12, 9], [16, 13], [20, 17]];
    let total = 0;
    for (const [tip, base] of pairs) {
        total += Math.hypot(lm[tip].x - lm[base].x, lm[tip].y - lm[base].y, (lm[tip].z || 0) - (lm[base].z || 0)) / palmSize;
    }
    return Math.max(0, Math.min(1, (total - 1.2) / 2.3));
}

function countFingersUp(lm) {
    let n = 0;
    const wristX = lm[0].x;
    if (Math.abs(lm[4].x - wristX) > Math.abs(lm[3].x - wristX)) n++; // 拇指
    if (lm[8].y < lm[6].y) n++;
    if (lm[12].y < lm[10].y) n++;
    if (lm[16].y < lm[14].y) n++;
    if (lm[20].y < lm[18].y) n++;
    return n;
}

function updateHandData(landmarksList) {
    if (!landmarksList || landmarksList.length === 0) {
        handData.detected = false;
        handData.twoHands = false;
        handData.landmarks = null;
        return;
    }
    const lm = landmarksList[0];
    handData.detected = true;
    handData.twoHands = landmarksList.length >= 2;
    handData.landmarks = lm;
    handData.palmX = (0.5 - lm[9].x) * 2;   // 镜像并放大到 [-1,1]
    handData.palmY = (0.5 - lm[9].y) * 2;   // 图像 y 向下 → 场景向上为正
    handData.fingersUp = countFingersUp(lm);
    handData.openness = calcOpenness(lm);
    handData.pinch = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y);
}

/**
 * 启动统一手势输入。
 * @param {object}   opts
 * @param {HTMLVideoElement} opts.video      用于承载摄像头流的 <video>
 * @param {Function} [opts.onResults]        每帧回调，参数为兼容旧 Hands 的结果对象
 * @param {number}   [opts.numHands=2]
 * @param {number}   [opts.fps=30]           检测频率上限
 * @returns {Promise<HandLandmarker>}
 */
export async function startHandInput({ video, onResults = null, numHands = 2, fps = 30 } = {}) {
    if (!video) throw new Error('startHandInput 需要 video 元素');
    _video = video;
    _onResults = onResults;
    _minInterval = 1000 / Math.max(1, fps);

    const fileset = await FilesetResolver.forVisionTasks(TASKS_VISION_WASM);
    // 依次尝试：本地模型(GPU) → 本地(CPU) → 远端(GPU)，最大化在国内/弱网/老显卡下的成功率
    const attempts = [
        { modelAssetPath: HAND_MODEL_LOCAL, delegate: 'GPU' },
        { modelAssetPath: HAND_MODEL_LOCAL, delegate: 'CPU' },
        { modelAssetPath: HAND_MODEL_REMOTE, delegate: 'GPU' },
    ];
    let lastErr = null;
    for (const baseOptions of attempts) {
        try {
            _landmarker = await HandLandmarker.createFromOptions(fileset, {
                baseOptions,
                runningMode: 'VIDEO',
                numHands,
            });
            console.log('[INFO] HandLandmarker 就绪:', baseOptions.modelAssetPath.includes('http') ? '远端模型' : '本地模型', baseOptions.delegate);
            break;
        } catch (e) {
            lastErr = e;
            console.warn('[WARN] HandLandmarker 初始化失败，尝试下一方案:', baseOptions.delegate, e?.message || e);
        }
    }
    if (!_landmarker) throw lastErr || new Error('HandLandmarker 初始化失败');

    await _acquireCameraAndLoop();
    return _landmarker;
}

// 获取摄像头流并启动检测循环（start 与 resume 共用，避免重复创建 landmarker）
async function _acquireCameraAndLoop() {
    if (!_video) return;
    _stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' },
        audio: false,
    });
    _video.srcObject = _stream;
    _video.setAttribute('playsinline', '');
    _video.muted = true;
    await new Promise((resolve, reject) => {
        _video.onloadedmetadata = () => _video.play().then(resolve).catch(reject);
        _video.onerror = () => reject(new Error('视频元素出错'));
        setTimeout(() => reject(new Error('摄像头启动超时')), 10000);
    });

    _running = true;
    const loop = () => {
        if (!_running) return;
        _rafId = requestAnimationFrame(loop);
        if (_video.readyState < 2) return;
        const now = performance.now();
        if (now - _lastTs < _minInterval) return; // 节流 + 保证时间戳严格递增
        _lastTs = now;

        let results;
        try {
            results = _landmarker.detectForVideo(_video, now);
        } catch (e) {
            return; // 偶发时间戳/上下文丢失，跳过该帧
        }
        const landmarks = results.landmarks || [];
        updateHandData(landmarks);
        if (_onResults) {
            // 整形为旧 @mediapipe/hands 兼容结构，复用主程序既有手势解析逻辑
            _onResults({
                multiHandLandmarks: landmarks,
                multiHandedness: results.handednesses || results.handedness || [],
                image: _video,
            });
        }
    };
    _rafId = requestAnimationFrame(loop);
}

/** 停止检测并释放摄像头（不销毁 landmarker，便于再次 start 复用）。 */
export function stopHandInput() {
    _running = false;
    if (_rafId) cancelAnimationFrame(_rafId);
    _rafId = null;
    if (_stream) {
        _stream.getTracks().forEach((t) => t.stop());
        _stream = null;
    }
    if (_video) _video.srcObject = null;
    handData.detected = false;
}

/** 临时释放摄像头（与 stop 等价，但语义上用于把摄像头让给制灯视频 iframe）。 */
export function pauseHandInput() {
    stopHandInput();
}

/** 恢复主程序摄像头（复用已创建的 landmarker，仅重新取流并启动循环）。失败自动重试一次。 */
export async function resumeHandInput() {
    if (_running) return;
    if (!_landmarker) return; // 从未初始化则忽略（init 时会自行 start）
    try {
        await _acquireCameraAndLoop();
    } catch (e) {
        console.warn('[WARN] 恢复摄像头失败，1 秒后重试:', e?.message || e);
        setTimeout(() => { if (!_running) _acquireCameraAndLoop().catch((err) => console.warn('[WARN] 摄像头重试仍失败:', err?.message || err)); }, 1000);
    }
}

/** 是否正在运行（已拿到摄像头并在检测）。 */
export function isHandInputRunning() {
    return _running;
}
