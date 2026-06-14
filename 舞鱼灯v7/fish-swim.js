/**
 * 鱼游泳动画模块
 * - 身体波浪变形（顶点着色器注入 + CPU 级摇摆后备）
 * - 窜动行为（dart & glide）
 * - 多鱼群（放生阶段 boids）
 */
import * as THREE from 'three';

// ═══════════════════════════════════════════════════════
// 1. 身体游泳动画 - 顶点着色器 + CPU 摇摆
// ═══════════════════════════════════════════════════════

/**
 * 给 GLB 鱼模型注入身体波浪动画
 * 双重保险：顶点着色器变形 + CPU 级子网格旋转摇摆
 */
export function applySwimDeformation(fishGroup, opts = {}) {
    const {
        speed = 4.0,         // 摆尾频率
        amplitude = 0.35,    // 摆尾幅度（大幅度确保可见）
        frequency = 2.0,     // 波长
        tailBias = 2.0,      // 尾部放大系数
    } = opts;

    const swimUniforms = {
        uSwimTime: { value: 0 },
        uSwimSpeed: { value: speed },
        uSwimAmp: { value: amplitude },
        uSwimFreq: { value: frequency },
        uTailBias: { value: tailBias },
        uZMin: { value: -1 },     // 身体轴坐标范围（按真实包围盒归一化）
        uZLen: { value: 2 },
        uAxisSel: { value: 2 },   // 身体长轴：0=X 2=Z（自动检测）
        uTurnBend: { value: 0 },  // 转弯 C 形弯曲量（宿主每帧喂 bankAngle/转向角）
    };

    // 收集所有子 mesh 用于 CPU 摇摆
    const meshes = [];
    let boundingBox = null;
    // 几何体局部空间包围盒：用于 ① 自动检测身体长轴（这批 GLB 多数沿 X 轴，不是 Z！
    // 波打错轴会变成整体果冻扭曲而非游动）② 按真实范围归一化身体坐标
    const geoMin = new THREE.Vector3(Infinity, Infinity, Infinity);
    const geoMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    fishGroup.traverse((obj) => {
        if (!obj.isMesh) return;
        meshes.push(obj);
        if (obj.geometry) {
            if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
            const bb = obj.geometry.boundingBox;
            if (bb) {
                geoMin.min(bb.min);
                geoMax.max(bb.max);
            }
        }
        // 计算整体包围盒
        if (!boundingBox) {
            boundingBox = new THREE.Box3().setFromObject(obj);
        } else {
            boundingBox.expandByObject(obj);
        }

        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((mat) => {
            mat.onBeforeCompile = (shader) => {
                shader.uniforms.uSwimTime = swimUniforms.uSwimTime;
                shader.uniforms.uSwimSpeed = swimUniforms.uSwimSpeed;
                shader.uniforms.uSwimAmp = swimUniforms.uSwimAmp;
                shader.uniforms.uSwimFreq = swimUniforms.uSwimFreq;
                shader.uniforms.uTailBias = swimUniforms.uTailBias;
                shader.uniforms.uZMin = swimUniforms.uZMin;
                shader.uniforms.uZLen = swimUniforms.uZLen;
                shader.uniforms.uAxisSel = swimUniforms.uAxisSel;
                shader.uniforms.uTurnBend = swimUniforms.uTurnBend;

                shader.vertexShader = shader.vertexShader.replace(
                    '#include <common>',
                    `#include <common>
                    uniform float uSwimTime;
                    uniform float uSwimSpeed;
                    uniform float uSwimAmp;
                    uniform float uSwimFreq;
                    uniform float uTailBias;
                    uniform float uZMin;
                    uniform float uZLen;
                    uniform float uAxisSel;
                    uniform float uTurnBend;
                    `
                );

                shader.vertexShader = shader.vertexShader.replace(
                    '#include <begin_vertex>',
                    `#include <begin_vertex>
                    // 身体坐标：沿自动检测的长轴归一化（0=头 1=尾），波形垂直于身体传播
                    float axisCoord = uAxisSel < 1.0 ? position.x : position.z;
                    float bodyPos = clamp((axisCoord - uZMin) / uZLen, 0.0, 1.0);
                    // X 轴鱼头在 -X 端（bodyPos 0=头）；Z 轴鱼鼻朝 +Z（max 端是头）→ 反转
                    if (uAxisSel >= 1.0) bodyPos = 1.0 - bodyPos;
                    // 头部稳定包络：头几乎不动(0.04)，振幅沿身体平方增长——真实鱼的推进形态
                    float tailFactor = 0.04 + 0.96 * pow(bodyPos, uTailBias);
                    // 摆幅 = uSwimAmp 视为「体长比例的一半」，对任意尺寸模型一致
                    float ampScale = uSwimAmp * uZLen * 0.5;
                    float phase = bodyPos * uSwimFreq * 6.2832 - uSwimTime * uSwimSpeed;
                    // 主行波 + 二级尾波（尾鳍末端 30% 高频颤动，鱼尾的"甩"感）
                    float wave = sin(phase) * ampScale * tailFactor;
                    float tailTip = smoothstep(0.7, 1.0, bodyPos);
                    wave += sin(phase * 2.0 + 0.9) * ampScale * 0.28 * tailTip;
                    // 转弯 C 形弯曲：身体整体往转向侧弓（uTurnBend 由宿主喂转向/倾斜角）
                    wave += bodyPos * bodyPos * uTurnBend * uZLen * 0.5;
                    // 位移打在垂直于身体轴的水平方向：X 轴鱼→Z 向摆，Z 轴鱼→X 向摆
                    if (uAxisSel < 1.0) { transformed.z += wave; } else { transformed.x += wave; }
                    // 侧面可见的垂直分量（尾鳍上下摆动效果）
                    float vWave = sin(phase + 1.57) * ampScale * tailFactor * 0.3;
                    transformed.y += vWave;
                    `
                );
            };
            mat.needsUpdate = true;
        });
    });

    // CPU 级摇摆：给整个 group 加一个可见的身体扭动
    // 这是后备方案，确保即使着色器注入失败也有视觉效果
    const bodyLength = boundingBox ? (boundingBox.max.z - boundingBox.min.z) : 1;

    // 自动检测身体长轴（X 或 Z 中较长者；Y 是高度不参与），写入范围与轴选择
    if (Number.isFinite(geoMin.x)) {
        const lenX = geoMax.x - geoMin.x;
        const lenZ = geoMax.z - geoMin.z;
        if (lenX >= lenZ && lenX > 0) {
            // 身体沿 X：头在 -X 端（与旧 stipple 着色器的 pos.x 尾部因子一致）
            swimUniforms.uAxisSel.value = 0;
            swimUniforms.uZMin.value = geoMin.x;
            swimUniforms.uZLen.value = lenX;
        } else if (lenZ > 0) {
            // 身体沿 Z：鼻子朝 +Z（fishQuaternionFromDirection 约定），头在 max 端 → 反转
            swimUniforms.uAxisSel.value = 2;
            swimUniforms.uZMin.value = geoMin.z;
            swimUniforms.uZLen.value = lenZ;
        }
    }

    return {
        uniforms: swimUniforms,
        update(time) {
            swimUniforms.uSwimTime.value = time;

            // CPU 摇摆已移至 app.js 的 animate 循环中统一处理
            // 不再在此覆盖 rotation.z，避免与侧视朝向冲突
        }
    };
}

// ═══════════════════════════════════════════════════════
// 1b. 运行时程序化绑骨（方案 A）：静态网格 → SkinnedMesh + 脊柱骨链
// goldfishies 式真骨骼游动：行波沿骨骼链传播、转弯曲率沿身体分布。
// 返回与 applySwimDeformation 完全相同的 uniforms 接口——
// 现有所有「每帧设 uSwimTime/uSwimSpeed/uSwimAmp/uTurnBend」的调用点零改动。
// ═══════════════════════════════════════════════════════
const _activeSpineRigs = [];
const _finTime = { value: 0 }; // 鳍部颤动全局时钟（updateSpineRigs 每帧推进）

// 鳍部颤动：身体骨骼只做侧摆，胸/腹/背鳍由顶点着色器按几何位置识别并高频颤动。
// 注入在模板材质上（克隆共享材质 → 全体实例生效）；与蒙皮叠加（begin_vertex 在 skinning 之前）。
function applyFinFlutter(mat, axis, latHalf, topY) {
    if (!mat || mat.userData._finFlutter) return;
    mat.userData._finFlutter = true;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader) => {
        if (prev) prev(shader);
        shader.uniforms.uFinTime = _finTime;
        shader.uniforms.uFinLat = { value: latHalf };
        shader.uniforms.uFinTop = { value: topY };
        shader.uniforms.uFinAxis = { value: axis === 'x' ? 0 : 2 };
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>
                uniform float uFinTime;
                uniform float uFinLat;
                uniform float uFinTop;
                uniform float uFinAxis;`)
            .replace('#include <begin_vertex>', `#include <begin_vertex>
                {
                    float latC = uFinAxis < 1.0 ? position.z : position.x;
                    float alongC = uFinAxis < 1.0 ? position.x : position.z;
                    // 鳍识别：侧向伸出（胸/腹鳍）或上缘（背鳍）的顶点
                    float finSide = smoothstep(uFinLat * 0.5, uFinLat, abs(latC));
                    float finTop = smoothstep(uFinTop * 0.62, uFinTop, position.y) * 0.6;
                    float fin = max(finSide, finTop);
                    if (fin > 0.001) {
                        float flut = sin(uFinTime * 5.6 + alongC * 2.4 + latC * 1.7) * fin * uFinLat * 0.22;
                        if (uFinAxis < 1.0) { transformed.z += flut * sign(latC + 0.0001) * 0.55; }
                        else { transformed.x += flut * sign(latC + 0.0001) * 0.55; }
                        transformed.y += flut * 0.3;
                    }
                }`);
    };
    mat.needsUpdate = true;
}

export function buildSpineRig(fishGroup, opts = {}) {
    const { boneCount = 7, tailBias = 2.2 } = opts;

    // 1) 几何体局部包围盒 → 身体长轴（X/Z 取长者）与头尾方向
    const geoMin = new THREE.Vector3(Infinity, Infinity, Infinity);
    const geoMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const sourceMeshes = [];
    fishGroup.traverse((obj) => {
        if (!obj.isMesh || !obj.geometry) return;
        sourceMeshes.push(obj);
        if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
        geoMin.min(obj.geometry.boundingBox.min);
        geoMax.max(obj.geometry.boundingBox.max);
    });
    if (!sourceMeshes.length || !Number.isFinite(geoMin.x)) {
        // 兜底：退回顶点着色器方案
        return applySwimDeformation(fishGroup, opts);
    }
    const lenX = geoMax.x - geoMin.x;
    const lenZ = geoMax.z - geoMin.z;
    const axis = lenX >= lenZ ? 'x' : 'z';
    const bodyLen = axis === 'x' ? lenX : lenZ;
    // X 轴鱼头在 -X 端；Z 轴鱼鼻朝 +Z（头在 max 端）
    const headCoord = axis === 'x' ? geoMin.x : geoMax.z;
    const tailDir = axis === 'x' ? 1 : -1; // 头→尾沿轴的符号

    // 鳍部颤动注入（模板材质；克隆共享）
    const finLatHalf = axis === 'x'
        ? Math.max(Math.abs(geoMin.z), Math.abs(geoMax.z))
        : Math.max(Math.abs(geoMin.x), Math.abs(geoMax.x));
    sourceMeshes.forEach((mesh) => {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((mat) => applyFinFlutter(mat, axis, finLatHalf, geoMax.y));
    });

    // 2) 骨骼链：root 在头部，沿身体均分（命名以便 SkeletonUtils.clone 后找回）
    const segLen = bodyLen / (boneCount - 1);
    const bones = [];
    for (let i = 0; i < boneCount; i++) {
        const bone = new THREE.Bone();
        bone.name = `spineBone_${i}`;
        if (i === 0) {
            bone.position[axis] = headCoord;
        } else {
            bone.position[axis] = tailDir * segLen;
            bones[i - 1].add(bone);
        }
        bones.push(bone);
    }
    // 先挂入场景并更新世界矩阵，再构造 Skeleton——
    // Skeleton 构造时立即用骨骼当前世界矩阵算 boneInverses，顺序错了蒙皮会全屏爆炸
    fishGroup.add(bones[0]);
    fishGroup.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(bones);

    // 3) 静态 Mesh → SkinnedMesh：按身体坐标线性混合相邻两节骨骼
    sourceMeshes.forEach((mesh) => {
        const geo = mesh.geometry;
        const pos = geo.attributes.position;
        const count = pos.count;
        const skinIndex = new Uint16Array(count * 4);
        const skinWeight = new Float32Array(count * 4);
        for (let v = 0; v < count; v++) {
            const c = axis === 'x' ? pos.getX(v) : pos.getZ(v);
            let t = ((c - headCoord) * tailDir) / segLen; // 距头多少节
            t = Math.min(Math.max(t, 0), boneCount - 1 - 1e-4);
            const i0 = Math.floor(t);
            const w1 = t - i0;
            skinIndex[v * 4] = i0;
            skinIndex[v * 4 + 1] = i0 + 1;
            skinWeight[v * 4] = 1 - w1;
            skinWeight[v * 4 + 1] = w1;
        }
        geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
        geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));

        const skinned = new THREE.SkinnedMesh(geo, mesh.material);
        skinned.name = mesh.name;
        skinned.position.copy(mesh.position);
        skinned.quaternion.copy(mesh.quaternion);
        skinned.scale.copy(mesh.scale);
        skinned.frustumCulled = false; // 骨骼形变后包围盒失效
        const parent = mesh.parent;
        parent.add(skinned);
        parent.remove(mesh);
        skinned.updateMatrixWorld(true);
        skinned.bind(skeleton, skinned.matrixWorld.clone());
    });

    // 4) 元数据存到 group：SkeletonUtils.clone 出的副本用 attachSpineRig 复挂控制器
    fishGroup.userData._spineMeta = { axis, boneCount, headCoord, bodyLen, tailBias };

    return _makeSpineController(bones, axis, boneCount, headCoord, bodyLen, tailBias, opts);
}

// 共享控制器工厂：行波沿骨骼链传播（头领身随）+ 尾鳍二级颤动 + 转弯 C 弯 + 微滚转
function _makeSpineController(bones, axis, boneCount, headCoord, bodyLen, tailBias, opts = {}) {
    const swimUniforms = {
        uSwimTime: { value: 0 },
        uSwimSpeed: { value: opts.speed ?? 4.0 },
        uSwimAmp: { value: opts.amplitude ?? 0.1 },
        uSwimFreq: { value: opts.frequency ?? 1.6 },
        uTailBias: { value: opts.tailBias ?? tailBias },
        uTurnBend: { value: 0 },
        uZMin: { value: headCoord },
        uZLen: { value: bodyLen },
        uAxisSel: { value: axis === 'x' ? 0 : 2 },
    };
    const style = opts.style || 'fish';
    const rig = {
        uniforms: swimUniforms,
        isSpineRig: true,
        bones,
        update(time) { swimUniforms.uSwimTime.value = time; },
        tick() {
            const u = swimUniforms;
            const t = u.uSwimTime.value;
            const phaseStep = (u.uSwimFreq.value * Math.PI * 2) / boneCount;
            if (style === 'crab') {
                // 螃蟹：身体不打波——横行碎步的左右摇摆 + 前后点头
                for (let i = 1; i < boneCount; i++) {
                    const bp = i / (boneCount - 1);
                    bones[i].rotation.y = Math.sin(t * u.uSwimSpeed.value * 1.7 + i * 0.9)
                        * u.uSwimAmp.value * 0.5 * bp;
                    bones[i].rotation.x = Math.sin(t * u.uSwimSpeed.value * 2.4 + i * 0.7)
                        * u.uSwimAmp.value * 0.7 * bp;
                    bones[i].rotation.z = Math.sin(t * u.uSwimSpeed.value * 1.1)
                        * u.uSwimAmp.value * 0.4 * bp;
                }
                return;
            }
            if (style === 'shrimp') {
                // 虾：周期性收腹弹尾（腹向卷曲脉冲），叠加微弱常规波
                const snap = Math.pow(Math.max(0, Math.sin(t * u.uSwimSpeed.value * 0.85)), 3);
                for (let i = 1; i < boneCount; i++) {
                    const bp = i / (boneCount - 1);
                    const env = 0.1 + 0.9 * bp;
                    bones[i].rotation.z = (axis === 'x' ? -1 : 1)
                        * (snap * u.uSwimAmp.value * 2.2 * env
                            + Math.sin(t * u.uSwimSpeed.value * 1.4 - i * phaseStep) * u.uSwimAmp.value * 0.5 * env);
                    bones[i].rotation.y = Math.sin(t * u.uSwimSpeed.value - i * phaseStep)
                        * u.uSwimAmp.value * 0.8 * env;
                }
                return;
            }
            for (let i = 1; i < boneCount; i++) {
                const bp = i / (boneCount - 1);
                const env = 0.06 + 0.94 * Math.pow(bp, u.uTailBias.value * 0.65);
                // 行波：每节骨骼依次延迟摆动（头领身随）
                let yaw = Math.sin(t * u.uSwimSpeed.value - i * phaseStep)
                    * u.uSwimAmp.value * 3.1 * env;
                // 尾鳍末端二级颤动（加强「甩尾」）
                if (bp > 0.72) {
                    yaw += Math.sin(t * u.uSwimSpeed.value * 2.0 - i * phaseStep + 0.9)
                        * u.uSwimAmp.value * 0.85;
                }
                // 转弯曲率沿身体分布（C 形弯）
                yaw += u.uTurnBend.value * 1.25 * bp / boneCount * 4;
                bones[i].rotation.y = yaw * (axis === 'x' ? 1 : -1);
                // 轻微滚转：身体扭动的生命感
                bones[i].rotation.z = Math.sin(t * u.uSwimSpeed.value - i * phaseStep + 1.57)
                    * u.uSwimAmp.value * 0.3 * env;
            }
        },
    };
    _activeSpineRigs.push(rig);
    return rig;
}

/**
 * 给 SkeletonUtils.clone 出的副本挂独立泳动控制器。
 * 副本已带自己的骨骼与正确蒙皮（SkeletonUtils 处理），这里只找回骨骼链并驱动——
 * 千万不要对克隆再跑 buildSpineRig（普通 clone 共享 geometry/骨架，二次蒙皮会互相污染）。
 */
export function attachSpineRig(clonedGroup, opts = {}) {
    const meta = clonedGroup.userData._spineMeta;
    if (!meta) return applySwimDeformation(clonedGroup, opts); // 模板没绑骨 → 退回着色器方案
    const bones = [];
    clonedGroup.traverse((obj) => {
        if (obj.isBone && obj.name.startsWith('spineBone_')) {
            bones[parseInt(obj.name.slice(10), 10)] = obj;
        }
    });
    if (bones.length !== meta.boneCount || bones.some((b) => !b)) {
        return applySwimDeformation(clonedGroup, opts);
    }
    return _makeSpineController(bones, meta.axis, meta.boneCount, meta.headCoord, meta.bodyLen, meta.tailBias, opts);
}

// 每帧统一驱动所有骨骼鱼 + 鳍部时钟（在 app.js animate 调一次）
export function updateSpineRigs(time) {
    if (typeof time === 'number') _finTime.value = time;
    for (const rig of _activeSpineRigs) rig.tick();
}


// ═══════════════════════════════════════════════════════
// 2. 窜动行为（Dart & Glide）- FISHING 阶段
// ═══════════════════════════════════════════════════════

// 共享临时变量（避免每帧 GC）
const _forward = new THREE.Vector3(0, 0, 1); // 鱼模型鼻子方向 (+Z)
const _qTarget = new THREE.Quaternion();
const _qBank = new THREE.Quaternion();
const _tmpV3 = new THREE.Vector3();
const _desiredDir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _corrUp = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _worldUp = new THREE.Vector3(0, 1, 0);

/**
 * 从 direction 计算鱼的四元数，保证鱼背(+Y)始终朝上、鱼鼻(+Z)指向 direction
 * 避免 setFromUnitVectors 在某些角度产生意外翻滚
 */
function fishQuaternionFromDirection(direction, quaternion) {
    // right = worldUp × direction（鱼的局部X轴）
    _right.crossVectors(_worldUp, direction);
    if (_right.lengthSq() < 0.001) {
        // direction 几乎垂直（极端情况），用 fallback
        _right.set(0, 0, -1);
    }
    _right.normalize();
    // correctedUp = direction × right（鱼的局部Y轴 = 鱼背方向）
    _corrUp.crossVectors(direction, _right).normalize();
    // 构造旋转矩阵：列 = [right, correctedUp, direction]
    _mat4.makeBasis(_right, _corrUp, direction);
    quaternion.setFromRotationMatrix(_mat4);
}

/**
 * 鱼自然游动控制器 - 纯侧影模式
 * 方向强制XY平面（z=0），相机在z轴始终看到侧面
 * 位置可有Z深度变化（近大远小）
 */
export class FishDartController {
    constructor(bounds = { x: 100, y: 60, z: 25 }) {
        this.bounds = bounds;
        this.pos = new THREE.Vector3(
            (Math.random() - 0.5) * bounds.x * 0.5,
            (Math.random() - 0.5) * bounds.y * 0.5,
            (Math.random() - 0.5) * (bounds.z || 25) * 0.3
        );
        this.velocity = new THREE.Vector3();
        this.speed = 55 + Math.random() * 20;
        this.targetSpeed = this.speed;
        
        // direction 强制XY平面（纯侧影）
        const initAngle = Math.random() * Math.PI * 2;
        this.direction = new THREE.Vector3(
            Math.cos(initAngle),
            Math.sin(initAngle) * 0.3,
            0
        ).normalize();
        this.quaternion = new THREE.Quaternion();
        fishQuaternionFromDirection(this.direction, this.quaternion);
        this.prevDir = this.direction.clone();
        
        // 期望方向（XY平面角度）
        this.desiredAngle = initAngle;
        
        // 兼容旧代码
        this.heading = initAngle;
        this.displayHeading = initAngle;
        this.bank = 0;
        
        // 漫游参数
        this.wanderTimer = 0;
        this.wanderInterval = 5.0 + Math.random() * 4.0;
        this.burstTimer = 0;
        this.burstCooldown = 3.0 + Math.random() * 4;
        this.isBursting = false;
        
        // 转向速率（弧度/秒）
        this.turnRate = 0.8;
    }

    update(dt) {
        this.turnRate += (0.8 - this.turnRate) * dt * 1.5;

        // 漫游：XY平面内方向变化
        this.wanderTimer += dt;
        if (this.wanderTimer > this.wanderInterval) {
            this.wanderTimer = 0;
            this.wanderInterval = 5.0 + Math.random() * 4.0;
            this.desiredAngle += (Math.random() - 0.5) * 2.0;
        }

        // burst/glide
        this.burstTimer += dt;
        if (!this.isBursting && this.burstTimer > this.burstCooldown) {
            this.isBursting = true;
            this.targetSpeed = 110 + Math.random() * 50;
            this.burstTimer = 0;
            this.burstCooldown = 3 + Math.random() * 4;
        }
        if (this.isBursting) {
            if (this.burstTimer > 0.5 + Math.random() * 0.4) {
                this.isBursting = false;
                this.targetSpeed = 35 + Math.random() * 25;
            }
        }

        this.speed += (this.targetSpeed - this.speed) * dt * 2.0;

        // 期望方向（XY平面，z=0）
        const yFactor = this._attracting ? 0.8 : 0.4;
        _desiredDir.set(
            Math.cos(this.desiredAngle),
            Math.sin(this.desiredAngle) * yFactor,
            0
        ).normalize();
        this._attracting = false; // 每帧重置，需再次调用attractTo才保持

        // XY边界力（提前转向，越近力越强）
        const margin = 0.35;
        const bx = this.bounds.x, by = this.bounds.y;
        if (Math.abs(this.pos.x) > bx * margin) {
            const t = (Math.abs(this.pos.x) - bx * margin) / (bx * (1 - margin));
            _desiredDir.x -= Math.sign(this.pos.x) * t * t * 8;
        }
        if (Math.abs(this.pos.y) > by * margin) {
            const t = (Math.abs(this.pos.y) - by * margin) / (by * (1 - margin));
            _desiredDir.y -= Math.sign(this.pos.y) * t * t * 8;
        }
        _desiredDir.z = 0;
        _desiredDir.normalize();

        // 限速转向
        const cosAngle = THREE.MathUtils.clamp(this.direction.dot(_desiredDir), -1, 1);
        const angle = Math.acos(cosAngle);
        if (angle > 0.001) {
            const maxTurn = this.turnRate * dt;
            const t = Math.min(maxTurn / angle, 1.0);
            this.direction.lerp(_desiredDir, t).normalize();
        }
        this.direction.z = 0;
        this.direction.normalize();

        // XY移动
        this.velocity.copy(this.direction).multiplyScalar(this.speed * dt);
        this.pos.add(this.velocity);

        // Z缓慢随机漂移
        const bz = this.bounds.z || 25;
        this.pos.z += (Math.random() - 0.5) * dt * 3;

        // 边界反弹：撞墙立即掉头（避免后退/卡住）
        if (Math.abs(this.pos.x) >= bx && Math.sign(this.pos.x) === Math.sign(this.direction.x)) {
            this.direction.x *= -1;
            this.desiredAngle = Math.atan2(this.direction.y, this.direction.x);
        }
        if (Math.abs(this.pos.y) >= by && Math.sign(this.pos.y) === Math.sign(this.direction.y)) {
            this.direction.y *= -1;
            this.desiredAngle = Math.atan2(this.direction.y, this.direction.x);
        }
        this.direction.normalize();

        this.pos.x = THREE.MathUtils.clamp(this.pos.x, -bx, bx);
        this.pos.y = THREE.MathUtils.clamp(this.pos.y, -by, by);
        this.pos.z = THREE.MathUtils.clamp(this.pos.z, -bz, bz);

        // 四元数（纯侧影）
        fishQuaternionFromDirection(this.direction, this.quaternion);
        this.prevDir.copy(this.direction);

        this.heading = Math.atan2(this.direction.y, this.direction.x);
        this.displayHeading = this.heading;
        this.bank = 0;
    }

    /** 被手势吸引（XY平面） */
    attractTo(handX, handY) {
        const dx = handX - this.pos.x;
        const dy = handY - this.pos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        this.desiredAngle = Math.atan2(dy, dx);
        // 靠近时减速（避免绕行轨道）
        this.targetSpeed = dist < 40 ? 20 + dist * 0.5 : 45;
        // 靠近时加快转向
        this.turnRate = dist < 40 ? 2.5 : 1.2;
        this._attracting = true;
    }
}


// ═══════════════════════════════════════════════════════
// 3. 多鱼群 - 放生阶段 Boids（纯侧影）
// ═══════════════════════════════════════════════════════

/**
 * 鱼群系统 - 纯侧影模式
 * direction 强制XY平面，位置可有Z深度
 */
export class FishSchool {
    constructor(templates, count = 8, bounds = { x: 120, y: 80, z: 30 }) {
        this.count = count;
        this.bounds = { x: bounds.x || 120, y: bounds.y || 80, z: bounds.z || 30 };
        this.container = new THREE.Group();
        this.fishes = [];
        
        const templateArr = Array.isArray(templates) ? templates : [templates];

        for (let i = 0; i < count; i++) {
            const template = templateArr[i % templateArr.length];
            const clone = template.clone(true);
            clone.scale.copy(template.scale);
            const sizeFactor = 0.20 + Math.random() * 0.10;
            clone.scale.multiplyScalar(sizeFactor);
            clone.visible = true;

            const angle = Math.random() * Math.PI * 2;
            const speed = 35 + Math.random() * 25;
            const dir = new THREE.Vector3(
                Math.cos(angle),
                Math.sin(angle) * 0.3,
                0
            ).normalize();

            const fish = {
                mesh: clone,
                pos: new THREE.Vector3(
                    (Math.random() - 0.5) * this.bounds.x * 0.6,
                    (Math.random() - 0.5) * this.bounds.y * 0.6,
                    (Math.random() - 0.5) * this.bounds.z * 0.6
                ),
                direction: dir.clone(),
                speed: speed,
                targetSpeed: speed,
                swimPhase: Math.random() * Math.PI * 2,
                swimSpeed: 3.0 + Math.random() * 2.0,
                quaternion: new THREE.Quaternion(),
                prevDir: dir.clone(),
                bankAngle: 0,
                turnRate: 0.5 + Math.random() * 0.3,
            };

            fishQuaternionFromDirection(dir, fish.quaternion);
            clone.quaternion.copy(fish.quaternion);

            this.fishes.push(fish);
            this.container.add(clone);
        }
    }

    update(dt, time, handPos = null) {
        const SEP_DIST = 30;
        const ALIGN_DIST = 70;
        const COHESION_DIST = 100;

        for (let i = 0; i < this.count; i++) {
            const fish = this.fishes[i];

            // Boids 力
            const sep = new THREE.Vector3();
            const align = new THREE.Vector3();
            const cohesion = new THREE.Vector3();
            let sepCount = 0, alignCount = 0, cohesionCount = 0;

            for (let j = 0; j < this.count; j++) {
                if (i === j) continue;
                const other = this.fishes[j];
                const dist = fish.pos.distanceTo(other.pos);
                if (dist < SEP_DIST && dist > 0.1) {
                    _tmpV3.subVectors(fish.pos, other.pos).normalize().divideScalar(dist);
                    sep.add(_tmpV3);
                    sepCount++;
                }
                if (dist < ALIGN_DIST) {
                    align.add(other.direction);
                    alignCount++;
                }
                if (dist < COHESION_DIST) {
                    cohesion.add(other.pos);
                    cohesionCount++;
                }
            }

            _desiredDir.copy(fish.direction);

            if (sepCount > 0) {
                sep.divideScalar(sepCount).normalize();
                _desiredDir.add(sep.multiplyScalar(1.2));
            }
            if (alignCount > 0) {
                align.divideScalar(alignCount).normalize();
                _desiredDir.add(align.multiplyScalar(0.8));
            }
            if (cohesionCount > 0) {
                cohesion.divideScalar(cohesionCount);
                _tmpV3.subVectors(cohesion, fish.pos).normalize();
                _desiredDir.add(_tmpV3.multiplyScalar(0.4));
            }

            // 手势吸引
            if (handPos) {
                _tmpV3.set(handPos.x || 0, handPos.y || 0, 0).sub(fish.pos);
                const handDist = _tmpV3.length();
                if (handDist > 15) {
                    _desiredDir.add(_tmpV3.normalize().multiplyScalar(0.5));
                }
            }

            // XY边界力（提前转向）
            const bx = this.bounds.x, by = this.bounds.y, bz = this.bounds.z;
            const margin = 0.35;
            if (Math.abs(fish.pos.x) > bx * margin) {
                const t = (Math.abs(fish.pos.x) - bx * margin) / (bx * (1 - margin));
                _desiredDir.x -= Math.sign(fish.pos.x) * t * t * 8;
            }
            if (Math.abs(fish.pos.y) > by * margin) {
                const t = (Math.abs(fish.pos.y) - by * margin) / (by * (1 - margin));
                _desiredDir.y -= Math.sign(fish.pos.y) * t * t * 8;
            }

            // 强制XY平面
            _desiredDir.z = 0;
            _desiredDir.normalize();

            // 限速转向
            const cosAngle = THREE.MathUtils.clamp(fish.direction.dot(_desiredDir), -1, 1);
            const angle = Math.acos(cosAngle);
            if (angle > 0.001) {
                const maxTurn = fish.turnRate * dt;
                const t = Math.min(maxTurn / angle, 1.0);
                fish.direction.lerp(_desiredDir, t).normalize();
            }
            fish.direction.z = 0;
            fish.direction.normalize();

            // 速度
            fish.targetSpeed = 40 + Math.sin(time * 0.4 + fish.swimPhase) * 18;
            fish.speed += (fish.targetSpeed - fish.speed) * dt * 2;

            // XY移动
            fish.pos.addScaledVector(fish.direction, fish.speed * dt);

            // Z随机漂移
            fish.pos.z += (Math.random() - 0.5) * dt * 2;

            // 边界反弹：撞墙立即掉头
            if (Math.abs(fish.pos.x) >= bx && Math.sign(fish.pos.x) === Math.sign(fish.direction.x)) {
                fish.direction.x *= -1;
            }
            if (Math.abs(fish.pos.y) >= by && Math.sign(fish.pos.y) === Math.sign(fish.direction.y)) {
                fish.direction.y *= -1;
            }
            fish.direction.normalize();

            // 边界
            fish.pos.x = THREE.MathUtils.clamp(fish.pos.x, -bx, bx);
            fish.pos.y = THREE.MathUtils.clamp(fish.pos.y, -by, by);
            fish.pos.z = THREE.MathUtils.clamp(fish.pos.z, -bz, bz);

            // 四元数（纯侧影）
            fishQuaternionFromDirection(fish.direction, fish.quaternion);
            fish.prevDir.copy(fish.direction);

            // 应用到 mesh
            fish.mesh.position.copy(fish.pos);
            fish.mesh.quaternion.copy(fish.quaternion);

            // 摆尾
            const spdRatio = fish.speed / 70;
            const wiggleAmp = 0.03 + spdRatio * 0.03;
            const wiggle = Math.sin((time + fish.swimPhase) * fish.swimSpeed) * wiggleAmp;
            fish.mesh.rotateY(wiggle);

            // 鱼鳞微光
            const shimmer = spdRatio * 0.15;
            const sparkle = Math.max(0, Math.sin(time * 6 + fish.swimPhase * 10)) * shimmer;
            fish.mesh.traverse((obj) => {
                if (obj.isMesh && obj.material && obj.material.emissive) {
                    obj.material.emissiveIntensity = 0.03 + sparkle * 0.25;
                }
            });
        }
    }

    dispose() {
        if (this.container.parent) this.container.parent.remove(this.container);
        this.fishes = [];
    }
}