const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const app = express();
require('dotenv').config(); // 安装 dotenv: npm install dotenv

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
    return res.status(400).json({ success: false, message: '参数缺失' });
  }

  const room = rooms[roomCode];
  if (!room) {
    return res.status(404).json({ success: false, message: '房间不存在' });
  }

  // 保存用户消息
  room.messages.push({ sender: username, text: message });

  // 调用硅基流动 API
  try {
    const response = await fetch('https://api.siliconflow.com/v1/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.sk-jdjxvdqaxekuseopncjkiuercaptcgttojuvszbjlbqtqbum}`, // 从环境变量读取密钥
      },
      body: JSON.stringify({
        model: 'siliconflow-model',
        messages: [
          { role: 'system', content: '你是一个调解员，帮助用户解决纠纷。' },
          { role: 'user', content: message },
        ],
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'API 调用失败');

    // 提取回复内容
    const reply = data.choices[0].message.content;
    room.messages.push({ sender: '调解员', text: reply });

    res.json({ success: true, reply });
  } catch (error) {
    console.error('硅基流动 API 错误:', error);
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