const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const app = express();
require('dotenv').config();

// 配置中间件
app.use(cors());
app.use(bodyParser.json());

// 内存存储（生产环境需替换为数据库）
const rooms = {};

// ---------- 硅基流动 API 配置 ----------
const SILICONFLOW_CONFIG = {
  baseUrl: "https://api.siliconflow.cn/v1", // 官方域名
  model: "deepseek-ai/DeepSeek-V2.5",       // 官方模型名称
};

// ---------- 工具函数：调用硅基流动 API ----------
async function callSiliconFlowAPI(messages) {
  const apiUrl = `${SILICONFLOW_CONFIG.baseUrl}/chat/completions`;
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SILICONFLOW_API_KEY}`,
    },
    body: JSON.stringify({
      model: SILICONFLOW_CONFIG.model,
      messages: messages,
      response_format: { type: "json_object" }, // 要求返回 JSON 格式
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
  }

  return response.json();
}

// ---------- API 路由 ----------

// [1] 加入房间（保持不变）
app.post('/join', (req, res) => { /* ... */ });

// [2] 发送消息（核心修正）
app.post('/send', async (req, res) => {
  try {
    const { roomCode, username, message } = req.body;

    // 参数校验和房间逻辑（保持不变）
    // ...

    // 构建符合官方规范的 messages 格式
    const messages = [
      { 
        role: "system",
        content: "你是一个专业调解员，需输出 JSON 格式。", // 根据需求调整
      },
      { 
        role: "user",
        content: message,
      }
    ];

    // 调用硅基流动 API
    const data = await callSiliconFlowAPI(messages);
    const reply = data.choices[0].message.content;

    // 保存并返回回复
    room.messages.push({ sender: '调解员', text: reply });
    res.json({ success: true, reply });

  } catch (error) {
    console.error('消息处理失败:', error.message);
    res.status(500).json({ 
      success: false, 
      message: `调解员暂时无法回复: ${error.message}`
    });
  }
});

// [3] 退出房间（保持不变）
app.post('/leave', (req, res) => { /* ... */ });

// ---------- 服务器启动 ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log('硅基流动配置:', SILICONFLOW_CONFIG);
});