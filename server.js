// ---------- 依赖引入 ----------
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const app = express();

// ---------- 中间件配置 ----------
app.use(cors());
app.use(bodyParser.json());

// ---------- 内存存储 ----------
const rooms = {};

// ---------- 硅基流动 API 配置 ----------
const SILICONFLOW_CONFIG = {
  baseUrl: "https://api.siliconflow.cn/v1",
  model: "deepseek-ai/DeepSeek-V2.5",
  systemPrompt: "你是一个专业调解员，需用简洁中文回复"
};

// ---------- 工具函数：调用硅基流动 API ----------
// 敏感词列表
const SENSITIVE_WORDS = ['违规词1', '违规词2', '广告'];

// JWT验证中间件
const jwt = require('jsonwebtoken');
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: '未授权' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ success: false, message: '无效令牌' });
  }
};

async function callSiliconFlowAPI(userMessage) {
  // 敏感词检查
  if (SENSITIVE_WORDS.some(word => userMessage.includes(word))) {
    throw new Error('包含敏感内容');
  }
  const apiUrl = `${SILICONFLOW_CONFIG.baseUrl}/chat/completions`;
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SILICONFLOW_API_KEY}`,
    },
    body: JSON.stringify({
      model: SILICONFLOW_CONFIG.model,
      messages: [
        { role: "system", content: SILICONFLOW_CONFIG.systemPrompt },
        { role: "user", content: userMessage }
      ],
      temperature: 0.7,
      max_tokens: 500
    }),
  });

  if (!response.ok) {
    const error = await response.json(); // 获取详细错误信息
    throw new Error(`API 错误: ${error?.message || '未知错误'}`);
  }

  return response.json();
}

// ---------- 新增：获取用户账户信息 ----------
async function getUserAccountInfo() {
  try {
    const response = await fetch(`${SILICONFLOW_CONFIG.baseUrl}/userinfo`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.SILICONFLOW_API_KEY}`,
      }
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error?.message || '获取用户信息失败');
    }

    return await response.json();
  } catch (error) {
    console.error('用户信息接口错误:', error.message);
    throw error;
  }
}

// ---------- API 路由 ----------

// [1] 加入房间（添加用户余额检查）
app.post('/join', async (req, res) => {
  try {
    const { roomCode, username } = req.body;

    // 参数校验
    if (!roomCode?.trim() || !username?.trim()) {
      return res.status(400).json({ 
        success: false, 
        message: '房间号和昵称不能为空' 
      });
    }

    // ---------- 新增：检查账户余额 ----------
    const userInfo = await getUserAccountInfo();
    if (userInfo.balance <= 0) {
      return res.status(403).json({
        success: false,
        message: '账户余额不足，请联系管理员充值'
      });
    }

    // 初始化房间
    if (!rooms[roomCode]) {
      rooms[roomCode] = { 
        users: [], 
        messages: [],
        createdAt: new Date().toISOString()
      };
    }

    const room = rooms[roomCode];

    // 用户去重
    if (!room.users.includes(username)) {
      room.users.push(username);
    }

    res.json({
      success: true,
      history: room.messages,
      users: room.users,
      userBalance: userInfo.balance // 返回余额信息
    });

  } catch (error) {
    console.error('加入房间错误:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message.includes('balance') 
        ? '账户状态检查失败' 
        : '服务器错误' 
    });
  }
});

// [2] 发送消息（优化错误处理）
app.post('/send', async (req, res) => {
  try {
    const { roomCode, username, message } = req.body;

    // 参数校验
    if (!roomCode || !username || !message) {
      return res.status(400).json({ 
        success: false, 
        message: '参数不完整' 
      });
    }

    const room = rooms[roomCode];
    if (!room) {
      return res.status(404).json({ 
        success: false, 
        message: '房间不存在' 
      });
    }

    // ---------- 新增：调用前检查余额 ----------
    const userInfo = await getUserAccountInfo();
    if (userInfo.balance <= 0) {
      return res.status(403).json({
        success: false,
        message: '余额不足，无法继续对话'
      });
    }

    // 保存用户消息
    room.messages.push({ 
      sender: username, 
      text: message, 
      timestamp: new Date().toISOString() 
    });

    // 调用 AI
    const aiResponse = await callSiliconFlowAPI(message);
    const aiMessage = aiResponse.choices[0].message.content;

    // 保存 AI 回复
    room.messages.push({ 
      sender: '调解员', 
      text: aiMessage, 
      timestamp: new Date().toISOString() 
    });

    res.json({ 
      success: true,
      reply: aiMessage,
      balance: userInfo.balance // 返回最新余额
    });

  } catch (error) {
    console.error('消息处理失败:', error.message);
    const statusCode = error.message.includes('balance') ? 402 : 500;
    res.status(statusCode).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// [3] 其他路由保持不变...

// ---------- 服务器启动 ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 服务器运行中: http://localhost:${PORT}`);
});