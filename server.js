// ---------- 依赖引入 ----------
require('dotenv').config(); // 加载环境变量（需安装 dotenv）
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const app = express();

// ---------- 中间件配置 ----------
app.use(cors()); // 允许跨域请求
app.use(bodyParser.json()); // 解析 JSON 请求体

// ---------- 内存存储（生产环境建议替换为数据库） ----------
const rooms = {}; // 结构: { [roomCode]: { users: [], messages: [] } }

// ---------- API 路由 ----------

// [1] 加入房间
app.post('/join', (req, res) => {
  try {
    const { roomCode, username } = req.body;

    // 参数校验
    if (!roomCode || !username) {
      return res.status(400).json({ success: false, message: '房间号和昵称不能为空' });
    }

    // 初始化房间
    if (!rooms[roomCode]) {
      rooms[roomCode] = { users: [], messages: [] };
    }
    const room = rooms[roomCode];

    // 添加用户（避免重复）
    if (!room.users.includes(username)) {
      room.users.push(username);
    }

    // 返回房间数据
    res.json({
      success: true,
      history: room.messages,
      users: room.users,
    });

  } catch (error) {
    console.error('加入房间错误:', error);
    res.status(500).json({ success: false, message: '服务器内部错误' });
  }
});

// [2] 发送消息（核心逻辑）
app.post('/send', async (req, res) => {
  try {
    const { roomCode, username, message } = req.body;

    // 参数校验
    if (!roomCode || !username || !message) {
      return res.status(400).json({ success: false, message: '参数缺失' });
    }

    // 验证房间存在性
    const room = rooms[roomCode];
    if (!room) {
      return res.status(404).json({ success: false, message: '房间不存在' });
    }

    // 保存用户消息
    room.messages.push({ sender: username, text: message });

    // ---------- 调用硅基流动 API ----------
    const apiUrl = 'https://api.siliconflow.com/v1/chat';
    const apiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SILICONFLOW_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'siliconflow-model', // 根据实际模型名称修改
        messages: [
          { 
            role: 'system', 
            content: '你是一个专业调解员，需遵循以下规则：\n1. 保持中立\n2. 引导用户寻找共同点\n3. 用简洁中文回复' 
          },
          { role: 'user', content: message }
        ],
        temperature: 0.7,
      }),
    });

    // ---------- 处理 API 响应 ----------
    // 处理 HTTP 错误状态码
    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      console.error('硅基流动 API 错误响应:', errorText);
      throw new Error(`API 请求失败: ${apiResponse.status} - ${errorText}`);
    }

    // 处理流式数据（如果 API 返回流式响应）
    const reader = apiResponse.body.getReader();
    let rawData = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rawData += new TextDecoder().decode(value);
    }

    // 解析 JSON（此处假设 rawData 是完整 JSON）
    const responseData = JSON.parse(rawData);
    console.log('硅基流动 API 响应数据:', JSON.stringify(responseData, null, 2)); // 调试日志

    // 提取回复内容（根据实际响应结构调整）
    const reply = responseData.choices?.[0]?.message?.content || '未收到有效回复';
    room.messages.push({ sender: '调解员', text: reply });

    // 返回成功响应
    res.json({ success: true, reply });

  } catch (error) {
    console.error('消息处理失败:', error.message);
    res.status(500).json({ 
      success: false, 
      message: `调解员暂时无法回复: ${error.message}`
    });
  }
});

// [3] 退出房间
app.post('/leave', (req, res) => {
  try {
    const { roomCode, username } = req.body;

    // 参数校验
    if (!roomCode || !username) {
      return res.status(400).json({ success: false, message: '参数缺失' });
    }

    // 移除用户
    const room = rooms[roomCode];
    if (room) {
      room.users = room.users.filter(user => user !== username);
    }

    res.json({ success: true });

  } catch (error) {
    console.error('退出房间错误:', error);
    res.status(500).json({ success: false, message: '服务器内部错误' });
  }
});

// ---------- 服务器启动 ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log('硅基流动 API 密钥状态:', process.env.SILICONFLOW_API_KEY ? '已配置' : '未配置');
});