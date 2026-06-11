/**
 * 交互式水波纹物理模拟
 * 基于 2D 波动方程 + FBO ping-pong + 折射渲染
 * 
 * 特性：
 * - 9-tap 各向同性模板（圆形扩散）
 * - Verlet 积分
 * - 非线性衰减（小振幅快衰减，大振幅慢衰减）
 * - 手指/鼠标触发波纹
 * - Sobel 梯度 → 折射偏移 + 色散 + 焦散
 */
import * as THREE from 'three';

const RIPPLE_SIZE = 256; // 物理模拟分辨率（半分辨率）

// ═══════════════════════════════════════════════════════
// 波动方程 Shader（物理模拟 pass）
// ═══════════════════════════════════════════════════════
const waveVertexShader = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const waveFragmentShader = `
    precision highp float;
    uniform sampler2D uPrev;      // 上一帧
    uniform sampler2D uCurr;      // 当前帧
    uniform float uDamping;       // 衰减系数
    uniform vec3 uFingers[10];    // 手指位置 [x, y, active]
    uniform float uDt;
    uniform float uTime;
    
    varying vec2 vUv;
    
    void main() {
        vec2 texel = vec2(1.0 / ${RIPPLE_SIZE}.0);
        
        // 9-tap 各向同性模板
        float curr = texture2D(uCurr, vUv).r;
        float prev = texture2D(uPrev, vUv).r;
        
        // 4 个轴向邻居（权重 0.2）
        float n = texture2D(uCurr, vUv + vec2(0.0, texel.y)).r;
        float s = texture2D(uCurr, vUv - vec2(0.0, texel.y)).r;
        float e = texture2D(uCurr, vUv + vec2(texel.x, 0.0)).r;
        float w = texture2D(uCurr, vUv - vec2(texel.x, 0.0)).r;
        
        // 4 个对角邻居（权重 0.05）
        float ne = texture2D(uCurr, vUv + vec2(texel.x, texel.y)).r;
        float nw = texture2D(uCurr, vUv + vec2(-texel.x, texel.y)).r;
        float se = texture2D(uCurr, vUv + vec2(texel.x, -texel.y)).r;
        float sw = texture2D(uCurr, vUv + vec2(-texel.x, -texel.y)).r;
        
        float avg = (n + s + e + w) * 0.2 + (ne + nw + se + sw) * 0.05;
        
        // Verlet 积分
        float val = avg * 2.0 - prev;
        
        // 非线性衰减：小振幅快衰减，大振幅慢衰减
        float ampFactor = 1.0 - smoothstep(0.0, 0.08, abs(val)) * 0.006;
        val *= uDamping * ampFactor;
        
        // 环境噪声（极低振幅的伪随机扰动）
        float noise = fract(sin(dot(vUv * uTime, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
        val += noise * 0.0003;
        
        // 手指触发力 - capsule SDF
        for (int i = 0; i < 10; i++) {
            if (uFingers[i].z > 0.5) {
                vec2 fingerPos = uFingers[i].xy;
                float dist = length(vUv - fingerPos);
                float baseRadius = 0.022;
                float force = smoothstep(baseRadius, 0.0, dist);
                val += force * 0.045;
            }
        }
        
        // clamp 防止爆掉
        val = clamp(val, -0.5, 0.5);
        
        gl_FragColor = vec4(val, val, val, 1.0);
    }
`;

// ═══════════════════════════════════════════════════════
// 渲染 Shader（折射 + 色散 + 焦散）
// ═══════════════════════════════════════════════════════
const renderVertexShader = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const renderFragmentShader = `
    precision highp float;
    uniform float uHighlightStrength;
    uniform sampler2D uWaveData;    // 波动数据
    uniform sampler2D uBackground;  // 背景纹理（摄像头或渐变）
    uniform float uIntensity;       // 整体强度
    uniform float uRefractStr;      // 折射强度
    uniform float uLensStr;         // 透镜强度
    uniform vec2 uAspect;           // 宽高比修正
    uniform float uTime;
    
    varying vec2 vUv;
    
    void main() {
        vec2 texel = vec2(1.0 / ${RIPPLE_SIZE}.0);
        
        // Sobel 梯度
        float tl = texture2D(uWaveData, vUv + vec2(-texel.x, texel.y)).r;
        float t  = texture2D(uWaveData, vUv + vec2(0.0, texel.y)).r;
        float tr = texture2D(uWaveData, vUv + vec2(texel.x, texel.y)).r;
        float l  = texture2D(uWaveData, vUv + vec2(-texel.x, 0.0)).r;
        float r  = texture2D(uWaveData, vUv + vec2(texel.x, 0.0)).r;
        float bl = texture2D(uWaveData, vUv + vec2(-texel.x, -texel.y)).r;
        float b  = texture2D(uWaveData, vUv + vec2(0.0, -texel.y)).r;
        float br = texture2D(uWaveData, vUv + vec2(texel.x, -texel.y)).r;
        
        float dx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
        float dy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
        vec2 grad = vec2(dx, dy);
        float gradLen = length(grad);
        
        // 折射偏移（不归一化 - 坡度越陡偏移越大）
        vec2 refractOffset = grad * uRefractStr * uIntensity * uAspect;
        
        // 透镜曲率项（Laplacian）
        float center = texture2D(uWaveData, vUv).r;
        float lap = (t + b + l + r) * 0.25 - center;
        vec2 lensOffset = vec2(0.0);
        if (gradLen > 0.001) {
            lensOffset = normalize(grad) * lap * uLensStr * uIntensity * uAspect;
        }
        
        vec2 totalOffset = refractOffset + lensOffset;
        
        // 色散（chromatic aberration）
        float dispersion = 0.015 + clamp(gradLen * 0.20, 0.0, 0.14);
        
        vec2 uvR = vUv + totalOffset * (1.0 + dispersion);
        vec2 uvG = vUv + totalOffset;
        vec2 uvB = vUv + totalOffset * (1.0 - dispersion);
        
        // 3-tap 软采样
        float red = texture2D(uBackground, uvR).r;
        float green = texture2D(uBackground, uvG).g;
        float blue = texture2D(uBackground, uvB).b;
        vec3 color = vec3(red, green, blue);
        
        // 波深明暗
        float data = texture2D(uWaveData, vUv).r;
        float brightness = 1.0 + clamp(data * 2.4, -0.32, 0.52);
        color *= brightness;
        
        // 波峰偏暖，波谷偏冷
        vec3 warmTint = vec3(1.06, 1.02, 0.94);
        vec3 coolTint = vec3(0.78, 0.90, 1.08);
        float tintFactor = clamp(data * 3.0, -1.0, 1.0);
        color *= mix(coolTint, warmTint, tintFactor * 0.5 + 0.5);
        
        // 焦散 caustics（高曲率波峰）
        float causticMask = smoothstep(0.03, 0.09, data) * smoothstep(0.01, 0.05, lap);
        color += vec3(0.95, 0.92, 0.85) * causticMask * 0.55 * uIntensity * uHighlightStrength;
        
        // Fresnel 反射边缘高光
        float fresnel = 0.02 + 0.15 * pow(gradLen * 5.0, 2.0);
        fresnel = clamp(fresnel, 0.0, 0.3);
        color = mix(color, vec3(0.7, 0.85, 1.0), fresnel * uHighlightStrength);
        
        // 整体冷色调（静止区微微泛蓝）
        float activity = clamp(abs(data) * 10.0 + gradLen * 5.0, 0.0, 1.0);
        vec3 stillTint = vec3(0.92, 0.95, 1.05);
        color *= mix(stillTint, vec3(1.0), activity);
        
        gl_FragColor = vec4(color, 1.0);
    }
`;

// ═══════════════════════════════════════════════════════
// WaterRipple 类
// ═══════════════════════════════════════════════════════
export class WaterRipple {
    constructor(renderer, camera) {
        this.renderer = renderer;
        this.camera = camera;
        this.fingers = new Array(30).fill(0); // vec3[10] flattened
        this.mouseActive = false;
        this.mousePos = { x: 0, y: 0 };
        
        // 创建 FBO ping-pong（3个 render target）
        const rtOptions = {
            type: THREE.FloatType,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
        };
        this.rtA = new THREE.WebGLRenderTarget(RIPPLE_SIZE, RIPPLE_SIZE, rtOptions);
        this.rtB = new THREE.WebGLRenderTarget(RIPPLE_SIZE, RIPPLE_SIZE, rtOptions);
        this.rtC = new THREE.WebGLRenderTarget(RIPPLE_SIZE, RIPPLE_SIZE, rtOptions);
        
        // 用于物理模拟的正交场景
        this.simScene = new THREE.Scene();
        this.simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        
        // 波动方程 material
        this.waveMaterial = new THREE.ShaderMaterial({
            uniforms: {
                uPrev: { value: this.rtA.texture },
                uCurr: { value: this.rtB.texture },
                uDamping: { value: 0.991 },
                uFingers: { value: new Array(30).fill(0) },
                uDt: { value: 0.016 },
                uTime: { value: 0 },
            },
            vertexShader: waveVertexShader,
            fragmentShader: waveFragmentShader,
        });
        
        const simQuad = new THREE.Mesh(
            new THREE.PlaneGeometry(2, 2),
            this.waveMaterial
        );
        this.simScene.add(simQuad);
        
        // 背景纹理（摄像头 or 渐变）
        this.bgTexture = this._createGradientTexture();
        this.watercolorTexture = null;
        this.watercolorMode = false;
        this.cameraTexture = null;
        this.useCameraFeed = false;
        
        // 最终渲染场景（折射渲染）
        this.renderScene = new THREE.Scene();
        this.renderMaterial = new THREE.ShaderMaterial({
            uniforms: {
                uWaveData: { value: this.rtC.texture },
                uBackground: { value: this.bgTexture },
                uIntensity: { value: 0.72 },
                uRefractStr: { value: 0.62 },
                uLensStr: { value: 0.22 },
                uHighlightStrength: { value: 1.0 },
                uAspect: { value: new THREE.Vector2(1, 1) },
                uTime: { value: 0 },
            },
            vertexShader: renderVertexShader,
            fragmentShader: renderFragmentShader,
        });
        
        this.renderQuad = new THREE.Mesh(
            new THREE.PlaneGeometry(2, 2),
            this.renderMaterial
        );
        this.renderScene.add(this.renderQuad);
        
        // 输出 render target（供主场景使用）
        this.outputRT = new THREE.WebGLRenderTarget(
            window.innerWidth, window.innerHeight,
            { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }
        );
        
        // 鼠标/触摸交互
        this._setupMouseInteraction();
    }
    
    _createGradientTexture() {
        return this._createThemedTexture({
            c1: '#143a5c', c2: '#061018', accent: '#1e6090'
        });
    }
    
    /**
     * 设置摄像头视频作为背景纹理
     */
    setCameraVideo(videoElement) {
        this.cameraTexture = new THREE.VideoTexture(videoElement);
        this.cameraTexture.minFilter = THREE.LinearFilter;
        this.cameraTexture.magFilter = THREE.LinearFilter;
        this.useCameraFeed = true;
        this.renderMaterial.uniforms.uBackground.value = this.cameraTexture;
    }
    
    /**
     * 更新手指位置（从 MediaPipe）
     * fingers: [{x, y, active}] 最多10个
     */
    setFingerPositions(fingerData) {
        const arr = this.waveMaterial.uniforms.uFingers.value;
        for (let i = 0; i < 30; i++) arr[i] = 0;

        const limit = Math.min(fingerData.length, 10);
        let anyActive = false;
        for (let i = 0; i < limit; i++) {
            if (fingerData[i]) {
                arr[i * 3] = fingerData[i].x;
                arr[i * 3 + 1] = fingerData[i].y;
                const inject = fingerData[i].active && (this._rippleCooldown || 0) <= 0;
                arr[i * 3 + 2] = inject ? 1.0 : 0.0;
                if (inject) anyActive = true;
            }
        }
        if (anyActive) this._rippleCooldown = 5;
    }
    
    _setupMouseInteraction() {
        // 鼠标/触摸交互在主 canvas 上
        // 注意：由于 OrbitControls 也监听鼠标，我们用右键或中键触发波纹
        // 也可通过 addRippleAt(x, y) 方法从外部触发
        const canvas = this.renderer.domElement;
        
        const getUV = (e) => {
            const rect = canvas.getBoundingClientRect();
            return {
                x: (e.clientX - rect.left) / rect.width,
                y: 1.0 - (e.clientY - rect.top) / rect.height
            };
        };
        
        // 右键触发波纹（左键留给 OrbitControls）
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        
        canvas.addEventListener('mousedown', (e) => {
            if (e.button === 2) { // 右键
                this.mouseActive = true;
                this._addMouseForce(getUV(e));
            }
        });
        
        canvas.addEventListener('mousemove', (e) => {
            if (this.mouseActive) {
                this._addMouseForce(getUV(e));
            }
        });
        
        canvas.addEventListener('mouseup', (e) => {
            if (e.button === 2) this.mouseActive = false;
        });
        
        canvas.addEventListener('mouseleave', () => {
            this.mouseActive = false;
        });
        
        // 触摸支持（双指触发波纹，单指留给 OrbitControls）
        canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length >= 2) {
                this.mouseActive = true;
                for (let i = 0; i < Math.min(e.touches.length, 5); i++) {
                    const uv = getUV(e.touches[i]);
                    this._addFingerForce(i, uv);
                }
            }
        }, { passive: true });
        
        canvas.addEventListener('touchmove', (e) => {
            if (this.mouseActive && e.touches.length >= 2) {
                for (let i = 0; i < Math.min(e.touches.length, 5); i++) {
                    const uv = getUV(e.touches[i]);
                    this._addFingerForce(i, uv);
                }
            }
        }, { passive: true });
        
        canvas.addEventListener('touchend', () => {
            this.mouseActive = false;
            // 清除所有 finger slots
            const arr = this.waveMaterial.uniforms.uFingers.value;
            for (let i = 0; i < 30; i += 3) arr[i + 2] = 0.0;
        });
    }
    
    _addFingerForce(slot, uv) {
        const arr = this.waveMaterial.uniforms.uFingers.value;
        const idx = slot * 3;
        arr[idx] = uv.x;
        arr[idx + 1] = uv.y;
        arr[idx + 2] = 1.0;
    }
    
    _addMouseForce(uv) {
        // 用 finger slot 9 作为鼠标（避免覆盖 MediaPipe 的 0-4）
        const arr = this.waveMaterial.uniforms.uFingers.value;
        arr[27] = uv.x;
        arr[28] = uv.y;
        arr[29] = 1.0;
    }
    
    /**
     * 外部触发波纹（UV 坐标 0-1）
     */
    addRippleAt(x, y) {
        const arr = this.waveMaterial.uniforms.uFingers.value;
        arr[27] = x;
        arr[28] = y;
        arr[29] = 1.0;
        // 自动清除（下一帧会被 update 处理）
        setTimeout(() => { arr[29] = 0.0; }, 50);
    }
    
    /**
     * 切换水面颜色主题
     * @param {'blue'|'green'|'silver'} theme
     */
    setColorTheme(theme) {
        const themes = {
            blue: { c1: '#143a5c', c2: '#061018', accent: '#1e6090' },
            green: { c1: '#0f3a28', c2: '#041008', accent: '#2a8060' },
            silver: { c1: '#2a3040', c2: '#101018', accent: '#607090' },
            black: { c1: '#080808', c2: '#000000', accent: '#202020' },
            transparent: { c1: '#1a5080', c2: '#0a2848', accent: '#4090c0' },
        };
        const t = themes[theme] || themes.blue;
        this.bgTexture = this._createThemedTexture(t);
        if (!this.useCameraFeed && !this.watercolorMode) {
            this.renderMaterial.uniforms.uBackground.value = this.bgTexture;
        }
    }

    loadWatercolorBackground(url) {
        new THREE.TextureLoader().load(url, (texture) => {
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;
            this.watercolorTexture = texture;
            if (this.watercolorMode && !this.useCameraFeed) {
                this.renderMaterial.uniforms.uBackground.value = texture;
            }
        });
    }

    setWatercolorMode(enabled) {
        this.watercolorMode = enabled;
        this.renderMaterial.uniforms.uHighlightStrength.value = enabled ? 0.0 : 1.0;
        if (!this.useCameraFeed) {
            this.renderMaterial.uniforms.uBackground.value =
                enabled && this.watercolorTexture ? this.watercolorTexture : this.bgTexture;
        }
    }
    
    _createThemedTexture(theme) {
        const canvas = document.createElement('canvas');
        canvas.width = 512; canvas.height = 512;
        const ctx = canvas.getContext('2d');
        
        const grad = ctx.createRadialGradient(256, 180, 0, 256, 280, 420);
        grad.addColorStop(0, theme.accent || theme.c1);
        grad.addColorStop(0.35, theme.c1);
        grad.addColorStop(0.75, theme.c2);
        grad.addColorStop(1.0, theme.c2);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 512, 512);
        
        const grad2 = ctx.createLinearGradient(0, 0, 512, 512);
        grad2.addColorStop(0, 'rgba(180,220,255,0.06)');
        grad2.addColorStop(0.45, 'rgba(0,0,0,0)');
        grad2.addColorStop(1, 'rgba(120,180,255,0.04)');
        ctx.fillStyle = grad2;
        ctx.fillRect(0, 0, 512, 512);
        
        for (let i = 0; i < 10; i++) {
            const x = 80 + Math.random() * 352;
            const y = 80 + Math.random() * 352;
            const r = 50 + Math.random() * 90;
            const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
            glow.addColorStop(0, 'rgba(160, 220, 255, 0.07)');
            glow.addColorStop(0.5, 'rgba(100, 180, 240, 0.03)');
            glow.addColorStop(1, 'rgba(100, 180, 240, 0)');
            ctx.fillStyle = glow;
            ctx.fillRect(0, 0, 512, 512);
        }
        
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.needsUpdate = true;
        return tex;
    }

    /** 环境涟漪：随机位置轻触水面 */
    emitAmbientRipple() {
        const arr = this.waveMaterial.uniforms.uFingers.value;
        const slot = 8;
        arr[slot * 3] = 0.25 + Math.random() * 0.5;
        arr[slot * 3 + 1] = 0.25 + Math.random() * 0.5;
        arr[slot * 3 + 2] = 1.0;
        setTimeout(() => { arr[slot * 3 + 2] = 0.0; }, 80);
    }
    
    /**
     * 每帧更新
     */
    update(time) {
        if (this._rippleCooldown > 0) this._rippleCooldown--;
        this.waveMaterial.uniforms.uTime.value = time;
        this.waveMaterial.uniforms.uDt.value = 0.009;
        this.renderMaterial.uniforms.uTime.value = time;
        
        // 如果没有鼠标按下，清除鼠标 finger slot（slot 9）
        if (!this.mouseActive) {
            const arr = this.waveMaterial.uniforms.uFingers.value;
            arr[29] = 0.0;
        }
        
        // 更新摄像头纹理
        if (this.cameraTexture) {
            this.cameraTexture.needsUpdate = true;
        }
        
        // 物理模拟 pass: 从 rtA(prev) + rtB(curr) → rtC(next)
        this.waveMaterial.uniforms.uPrev.value = this.rtA.texture;
        this.waveMaterial.uniforms.uCurr.value = this.rtB.texture;
        
        this.renderer.setRenderTarget(this.rtC);
        this.renderer.render(this.simScene, this.simCamera);
        
        // 交换: A←B, B←C (ping-pong)
        const temp = this.rtA;
        this.rtA = this.rtB;
        this.rtB = this.rtC;
        this.rtC = temp;
        
        // 渲染 pass: 用波动数据做折射
        this.renderMaterial.uniforms.uWaveData.value = this.rtB.texture;
        
        this.renderer.setRenderTarget(this.outputRT);
        this.renderer.render(this.renderScene, this.simCamera);
        
        // 恢复默认渲染目标
        this.renderer.setRenderTarget(null);
    }
    
    /**
     * 获取输出纹理（供主场景平面使用）
     */
    getOutputTexture() {
        return this.outputRT.texture;
    }
    
    /**
     * 窗口大小改变时更新
     */
    resize(width, height) {
        this.outputRT.setSize(width, height);
        this.renderMaterial.uniforms.uAspect.value.set(
            width > height ? height / width : 1.0,
            height > width ? width / height : 1.0
        );
    }
    
    dispose() {
        this.rtA.dispose();
        this.rtB.dispose();
        this.rtC.dispose();
        this.outputRT.dispose();
        this.waveMaterial.dispose();
        this.renderMaterial.dispose();
    }
}
