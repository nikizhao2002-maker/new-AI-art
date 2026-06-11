/**
 * 统一鱼类清单 (fish-manifest.js) —— 单一事实源
 * ------------------------------------------------------------------
 * 解决三套代码命名分裂的问题：
 *   - 主程序 craft 流程: 浮金鱼影 / 红鲤之影 / 鲮鱼之影 / 狮子头鱼之影 / 石斑之影 (+ *鱼灯)
 *   - 粒子 demo:        浮金之影 / 火鲤之影 / 鲮鱼之影 / 石斑之影 / 狮子头鱼之影 / 虾灯 / 蟹灯
 * 这里用一份清单统一描述每种鱼，并把「虾灯 / 蟹灯」并入。
 *
 * 字段说明：
 *   id        程序内稳定标识
 *   name      展示名
 *   shadow    主程序 DataTexture 流程用的「鱼影」GLB (assets/models/)，无则 null
 *   lantern   主程序「鱼灯」成品 GLB (assets/models/)，无则 null
 *   particle  粒子场景 ParticleScene 用的稠密 GLB (assets/particle-models/)
 *   lore      知识卡片文案
 *
 * 消费方：
 *   - src/particle-scene.js  读取 particle 字段加载粒子模型
 *   - 主程序 craft 流程仍可沿用 glb-pointcloud.js 的 FISH_TYPES；
 *     如需统一，可改为从本清单 .filter(f => f.shadow) 生成。
 */

export const FISH = [
    {
        id: 'fujin', name: '浮金鱼',
        shadow: 'assets/models/浮金鱼影.glb', lantern: 'assets/models/浮金鱼灯.glb',
        particle: 'assets/particle-models/浮金之影.glb',
        lore: '浮金鱼灯，鳞光浮动如碎金，是顺德鱼灯里最华贵的一盏。',
    },
    {
        id: 'hongli', name: '红鲤',
        shadow: 'assets/models/红鲤之影.glb', lantern: 'assets/models/红鲤鱼灯.glb',
        particle: 'assets/particle-models/火鲤之影.glb',
        lore: '红鲤跃龙门，寓意鱼化为龙、步步高升，是节庆最常见的祈愿鱼灯。',
    },
    {
        id: 'shizitou', name: '狮子头',
        shadow: 'assets/models/狮子头鱼之影.glb', lantern: 'assets/models/狮子头鱼灯.glb',
        particle: 'assets/particle-models/狮子头鱼之影.glb',
        lore: '狮头鱼身，融狮舞与鱼灯于一体，威而不凶，护佑一方。',
    },
    {
        id: 'shiban', name: '石斑',
        shadow: 'assets/models/石斑之影.glb', lantern: 'assets/models/石斑鱼灯.glb',
        particle: 'assets/particle-models/石斑之影.glb',
        lore: '石斑斑纹错落，匠人以彩纸层层糊就，灯影里游出一片礁海。',
    },
    {
        id: 'ling', name: '鲮鱼',
        shadow: 'assets/models/鲮鱼之影.glb', lantern: 'assets/models/鲮鱼鱼灯.glb',
        particle: 'assets/particle-models/鲮鱼之影.glb',
        lore: '鲮鱼是岭南水乡的家常鱼，做成鱼灯，是把日子里的温饱也点亮。',
    },
    // ── 并入 pointcloud-demo 独有的两盏，仅用于粒子场景（无 craft 影模型）──
    {
        id: 'xia', name: '虾灯',
        shadow: null, lantern: 'assets/particle-models/虾灯.glb',
        particle: 'assets/particle-models/虾灯.glb',
        lore: '虾灯须长身曲，灯影一动便似在水中弹跃，是孩童最爱追的一盏。',
    },
    {
        id: 'xie', name: '蟹灯',
        shadow: null, lantern: 'assets/particle-models/蟹灯.glb',
        particle: 'assets/particle-models/蟹灯.glb',
        lore: '蟹灯八足横行，团圆喜庆，旧时多在中秋随月而出。',
    },
];

/** 仅含完整 craft 流程（有鱼影+鱼灯）的鱼，供主程序制灯阶段使用。 */
export const CRAFT_FISH = FISH.filter((f) => f.shadow && f.lantern);

/** 粒子场景可加载的模型名 → 路径映射。 */
export const PARTICLE_MODELS = FISH.map((f) => ({ id: f.id, name: f.name, url: f.particle }));

export function getFishById(id) {
    return FISH.find((f) => f.id === id) || null;
}

/**
 * 主程序 glb-pointcloud.js 的 FISH_TYPES 顺序
 * → 对应的粒子交互专用高面数鱼灯模型路径。供 app.js 用 currentFishIndex 直接取粒子模型，
 * 避免命名体系差异导致的脆弱匹配。
 */
export const HIGH_DETAIL_LANTERN_MODELS = [
    'assets/particle-models-50000/浮金鱼灯50000.glb',       // 0 浮金鱼
    'assets/particle-models-50000/狮子头鱼鱼灯50000.glb',   // 1 狮子头
    'assets/particle-models-50000/石斑鱼灯50000.glb',       // 2 石斑鱼
    'assets/particle-models-50000/火鲤鱼灯50000.glb',       // 3 红鲤鱼
    'assets/particle-models-50000/鲮鱼鱼灯50000.glb',       // 4 鲮鱼
    'assets/particle-models-50000/金鲤鱼灯50000.glb',       // 5 金鲤
    'assets/particle-models-50000/赤焰虾灯50000.glb',       // 6 海虾
    'assets/particle-models-50000/金甲蟹灯50000.glb',       // 7 螃蟹
];

export const CRAFT_INDEX_TO_PARTICLE = HIGH_DETAIL_LANTERN_MODELS;
