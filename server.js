const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const app = express();

// 启用 CORS 和 JSON 解析
app.use(cors());
app.use(bodyParser.json());

// 模拟聊天房间
const rooms = {};

// 加入房间（POST 请求）
app.post('/join', (req, res) => {
  const { roomCode, username } = req.body;
  if (!roomCode || !username) {
    return res.status(400).json({ success: false, message: '房间号和昵称不能为空' });
  }

  if (!rooms[roomCode]) {
    rooms[roomCode] = { users: [], messages: [] };
  }
  const room = rooms[roomCode];

  // 添加用户
  if (!room.users.includes(username)) {
    room.users.push(username);
  }

  // 返回历史记录和用户列表
  res.json({
    success: true,
    history: room.messages,
    users: room.users,
  });
});

// 发送消息（POST 请求）
app.post('/send', async (req, res) => {
  const { roomCode, username, message } = req.body;
  if (!roomCode || !username || !message) {
    return res.status(400).json({ success: false, message: '房间号、昵称和消息不能为空' });
  }

  const room = rooms[roomCode];
  if (!room) {
    return res.status(404).json({ success: false, message: '房间不存在' });
  }

  // 保存用户消息
  room.messages.push({ sender: username, text: message });

  // 调用 Ollama API 生成回复
  try {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-r1:1.5b', // 替换为你的模型名称
        prompt: `你是一个调解员，帮助用户解决纠纷。用户说：“${message}”`, // 提示词
        stream: false, // 关闭流式响应
      }),
    });
    const data = await response.json();

    // 获取 Ollama 的回复
    const reply = data.response; // Ollama 的回复字段是 response
    room.messages.push({ sender: '调解员', text: reply });

    res.json({ success: true, reply });
  } catch (error) {
    console.error('调用 Ollama API 失败:', error);
    res.status(500).json({ success: false, message: '调解员暂时无法回复' });
  }
});

// 退出房间（POST 请求）
app.post('/leave', (req, res) => {
  const { roomCode, username } = req.body;
  if (!roomCode || !username) {
    return res.status(400).json({ success: false, message: '房间号和昵称不能为空' });
  }

  const room = rooms[roomCode];
  if (!room) {
    return res.status(404).json({ success: false, message: '房间不存在' });
  }

  // 移除用户
  room.users = room.users.filter(user => user !== username);

  res.json({ success: true });
});

// 启动服务器
app.listen(3000, () => console.log('服务器运行在 http://localhost:3000'));