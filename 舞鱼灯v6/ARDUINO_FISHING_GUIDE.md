# Arduino 钓鱼交互集成指南

## ✅ 已完成的工作

### 1. **Arduino代码优化**
你的原始代码已改进，支持以下功能：
- 编码器旋转：发送 `ENCODER:num` (0-100)
- 按钮按下：发送 `BTN:PRESS`
- 波特率：9600 baud

### 2. **serial.js 更新**
- 改为接收编码器值而非FSR传感器
- 派发 `encoder-update` 事件（值：0-100）
- 派发 `button-press` 事件

### 3. **app.js 整合**
- 导入 `serial.js` 的 `rod` 对象
- 添加 Arduino 钓鱼交互变量：
  - `rodTension`: 0-100 张力百分比
  - `rodFishingState`: idle | biting | fighting
  - `rodFishingSuccessWindow`: [30, 70] 成功张力范围
  
### 4. **HTML UI**
- 钓竿控制面板（右上角）：
  - 连接按钮
  - 张力进度条
  - 钓鱼状态提示
  - 张力警告（>80%）

### 5. **钓鱼交互逻辑**
```
状态转换：
idle → biting (鱼咬钩，张力>10%)
      → fighting (高张力，>50%)
      → 成功钓起 (张力30-70%保持3秒)
```

---

## 🎣 用户操作流程

### 第1步：将改进的Arduino代码上传到开发板

```cpp
#define PinA 2  
#define PinB 3  
#define PinSW 4
unsigned long time = 0; 
long count = 0; 
long num = 0;
int i = 0;
int buttonPressed = 0;

void setup()
{
  Serial.begin(9600);
  pinMode(PinA, INPUT); 
  pinMode(PinB, INPUT);
  pinMode(PinSW, INPUT); 
  
  attachInterrupt(0, blinkA, LOW);  
  attachInterrupt(1, blinkB, LOW);
  time = millis(); 
}

void loop()
{
  // 发送编码器值（每次改变时发送）
  while (num != count)
  {
    i = 1;
    num = count;
    // 限制range 0-100（代表钓线张力 0%-100%）
    long displayNum = constrain(count, 0, 100);
    Serial.print("ENCODER:");
    Serial.println(displayNum);
  }
  
  // 检测按钮（钓竿按钮：尝试钓起或重置）
  if((digitalRead(PinSW) == LOW) && i==1)
  {
    i = 0;
    buttonPressed = 1;
    Serial.println("BTN:PRESS");  // 发送按钮按下事件
    
    count = 0;  // 重置计数
    while(digitalRead(PinSW) == LOW) delay(10);
    delay(20);  // 防抖
  }
}

void blinkA()
{
  if ((millis() - time) > 3)
    count++; 
  time = millis();
}

void blinkB()
{
  if ((millis() - time) > 3)  
    count--; 
  time = millis();
}
```

### 第2步：启动舞鱼灯网页

```bash
cd 舞鱼灯v6
python serve.py
```

访问：**http://localhost:8081/**

### 第3步：进入钓鱼阶段

1. 从水面阶段自然过渡，或在URL中添加 `?phase=fishing` 跳转
2. 右上角出现**钓竿控制面板**

### 第4步：连接Arduino

1. 点击面板中的 **「🔌 连接钓竿」** 按钮
2. 浏览器弹出设备选择对话框，选择你的Arduino设备
3. 连接成功后按钮变为 **「✓ 已连接」**

### 第5步：钓鱼交互

| 操作 | 效果 |
|------|------|
| **旋转编码器顺时针** | 张力增加（鱼在努力逃脱） |
| **旋转编码器逆时针** | 张力降低（放松钓线） |
| **按钮按下** | 尝试钓起（需要张力在30-70%范围内） |

### 钓鱼成功条件

- 张力保持在 **30-70%** 范围内 **3秒** 以上
- 或者在这个范围内按按钮
- ✅ 成功 → 进入制灯阶段

### 钓鱼失败情况

- ❌ 张力超过 80%：鱼线快断了（警告动画）
- ❌ 张力长期超过 70%：鱼会逃脱
- ❌ 超过 30 秒未成功：鱼跑掉了

---

## 🔧 调试指南

### 检查Arduino连接

在浏览器控制台（F12 → Console）查看：

```javascript
// 检查编码器值是否接收
window.addEventListener('encoder-update', (e) => {
    console.log('编码器值:', e.detail);
});

// 检查按钮事件
window.addEventListener('button-press', (e) => {
    console.log('按钮事件:', e.detail);
});
```

### 编码器值范围调整

如果需要修改张力范围，在 `app.js` 的 `enterPhase(PHASES.FISHING)` 中修改：

```javascript
// 修改成功范围
rodFishingSuccessWindow = [30, 70];  // 改为你想要的范围

// 修改高张力警告阈值
if (rodTension > 80) {  // 改为其他值
    showTensionWarning();
}
```

### 编码器值标定

Arduino中的 `constrain(count, 0, 100)` 限制了编码器值的范围。如需调整：

```cpp
// 如果一圈编码器脉冲数不是100，修改：
long displayNum = map(count, 0, pulsesPerTurn, 0, 100);
Serial.print("ENCODER:");
Serial.println(displayNum);
```

---

## 📊 UI 反馈说明

### 张力进度条
- **绿色（0-30%）**: 张力太松，鱼在下沉
- **黄色（30-70%）**: ✓ 张力正好，可以成功钓起
- **红色（70-100%）**: 张力过紧，鱼在挣扎，快要逃脱

### 状态文字
- 「等待鱼儿...」: 静等中
- 「🐟 鱼咬钩了！」: 鱼已上钩，调整张力
- 「✓ 张力正好」: 在成功范围内
- 「✗ 张力太松/太紧」: 需要调整

---

## ⚙️ 可自定义参数

在 `app.js` 中查找并修改：

| 参数 | 当前值 | 说明 |
|------|-------|------|
| `rodFishingSuccessWindow` | [30, 70] | 成功钓起的张力范围 |
| 警告阈值 | 80% | 张力超过此值显示警告 |
| 咬钩阈值 | 10% | 张力超过此值视为鱼咬钩 |
| 咬钩到对抗阈值 | 50% | 张力超过此值转为对抗状态 |
| 保持时间 | 3秒 | 在成功范围保持多久视为成功 |
| 全局超时 | 30秒 | 钓鱼阶段总超时 |

---

## 🎯 扩展功能建议

### 1. 鱼的视觉反馈
修改 `updateRodFishingState()` 中的鱼动画：
```javascript
if (targetFishInstance && targetFishInstance.swimCtrl) {
    // 根据张力值调整鱼的游泳幅度和频率
    fishSwimCtrl.uniforms.uSwimAmp.value = 0.1 + rodTugStrength * 0.3;
    fishSwimCtrl.uniforms.uSwimSpeed.value = 2.0 + rodTugStrength * 2.0;
}
```

### 2. 音效反馈
在 `updateRodFishingState()` 中添加：
```javascript
// 鱼咬钩时播放音效
if (rodFishingState === 'biting') {
    playTone({ freqs: 660, duration: 0.2, gain: 0.3 });
}
```

### 3. 减速马达反馈
如果Arduino上连接了振动马达：
```javascript
// 在 finishRodFishing() 中添加
await rod.send('VIBRATE:CELEBRATE');
```

---

## 📝 故障排除

| 问题 | 解决方案 |
|------|--------|
| 按钮连接失败 | 检查Chrome版本（89+），启用WebSerial: chrome://flags/#enable-experimental-web-platform-features |
| 编码器值不更新 | 检查Arduino串口输出格式是否为 `ENCODER:num\n` |
| 按钮无反应 | 检查Arduino中 `Serial.println("BTN:PRESS")` 是否正确发送 |
| UI不显示 | 打开浏览器控制台查看错误信息，检查 index.html 中的钓竿面板HTML是否存在 |

---

## 🎊 大功告成！

现在你的钓鱼交互已经完全整合了Arduino硬件编码器！享受沉浸式的钓鱼体验吧！

有任何问题或需要进一步定制，随时修改 app.js 和 serial.js 中的参数和逻辑。
