/* 核心依赖 */
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { OpenAI } = require('openai');
const { randomUUID } = require('crypto');
const generateUniqueId = require('./idGenerator');

// 角色存储结构
//const accounts = [];
/*{ id: '12345678',
    accountname: '测试账户',
    email: '111',
    password,
    createdAt: new Date().toISOString(),
    joinedRooms: [{ roomCode, roomName, roleName, password, lastAccessed }]}*/
// 房间存储结构
//const rooms = {};
/*{   code: roomCode,
      name: roomName,
      owner: accountID,
      password,
      mediatorInstruction: prompt,  // 添加提示词字段
      mediatorMode: parseInt(mode) || 1,  // 添加模式字段
      BackgroundMessage: [{ role, content}],
      members: [{
        roleID: accountID,
        roleName: roleName,
        selfIntroduction,
        description: [{tagID, relationshipDesc}],
        online: false,
        joinTime: new Date().toISOString(),
        lastChecked
      }],
      created: new Date().toISOString(),
      globalMessages: [{
        sender: sendername,   // bug，如果rolename更改，全局池里没有改变，导致历史上下文不对应
        id: messageObj.id,
        message,
        originalReply,
        content,
        target: targetrole,
        timestamp: Date.now()
      }],
      client
    }*/
// visitDatajson('clear');
const { accounts, rooms } = visitDatajson('read');

// 会话存储
const sessions = {};

/* 全局配置 */
const CONFIG = {
  enableSystemBroadcast: true
};

const MessageTypes = {
  SEND_MESSAGE: 'SEND_MESSAGE',
  REQUEST_UPDATE: 'REQUEST_UPDATE',
  ERROR: 'ERROR',
  SYSTEM_MESSAGE: 'SYSTEM_MESSAGE',
  ROOM_UPDATE: 'ROOM_UPDATE'
};

/* 服务实例 */
const app = express();
// 修改：动态获取端口（Render 会通过环境变量 PORT 分配端口）
const server = app.listen(process.env.PORT || 3001, () => {
  console.log(`服务器运行在 http://localhost:${process.env.PORT || 3001}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${process.env.PORT || 3001} 被占用，请关闭其他实例或更换端口`);
    process.exit(1);
  }
});

// 创建WebSocket服务器
// [功能] 创建WebSocket服务器实例
// [参数] server - 复用Express的HTTP服务器实现双协议监听
// [业务] 实现实时双向通信，端口绑定在3001确保与HTTP API统一入口
const wss = new WebSocketServer({ server });

// WebSocket连接管理模块
// 负责处理客户端连接、消息路由和异常处理
wss.on('connection', (ws, req) => {
  ws.on('message', (message) => {
    handleWebSocketMessage(ws, message);
  });
});

// 用户消息存储结构
/**
 * [模块] 消息调解中心
 * [结构说明]
 * - queue: 消息缓冲队列，实现流量削峰
 * - context: 维护对话上下文，确保调解连贯性
 * [工作流程]
 * 1. 消息入队 -> 2. 上下文构建 -> 3. AI调用 -> 4. 消息路由
 */
const MediationCenter = {
  queue: [],
  context: {},
  isProcessing: false,
  lastProcessedTimestamps: new Map(), // 添加房间级时间戳跟踪

  // 在消息处理队列入口处设置断点
  async processQueue() {
    while (this.queue.length > 0) {
      // 在这里左侧行号处点击添加断点
      this.isProcessing = true;      // 标记正在处理
      const messageObj = this.queue.shift();  // 从队列中取出消息
      if (messageObj.processed) return;
      const { roomCode, senderID, message } = messageObj;   // 获取房间信息
      const sendername = `${roomCode}_${senderID}`;  // 修改：拼接 roomCode 和 senderID 生成唯一标识
      messageObj.processed = true; // 从队列中取出消息
      const room = rooms[roomCode];  // 获取房间信息
      
      // 构建完整对话上下文
      const history = room.globalMessages
      .map(m => ({
        role: 'user',
        content: `${m.message}`
      }));    // 提取历史消息

      try {
        const client = new OpenAI({
          apiKey: 'sk-elysunjplbtqubfzrfhdpalkuijukorpsfxazdhxqhbgqfmy',
          baseURL: 'https://api.siliconflow.cn/v1'
        });

        const completion = await client.chat.completions.create({
          model: 'deepseek-ai/DeepSeek-V2.5',
          messages: [
            ...room.BackgroundMessage,    
            ...history,
            {
              role: 'user',
              content: `${sendername}：${message}`
            }
          ],
          temperature: 0.7
        }); // 调用API获取回复

        const originalReply = completion.choices[0].message.content;
        const targetMatch = originalReply.match(/@([\u4e00-\u9fa5a-zA-Z0-9_]+)：/);
        const targetrole = targetMatch ? targetMatch[1].toLowerCase() : sendername;
        const content = targetMatch ? originalReply.replace(targetMatch[0], '') : originalReply;


        const processedMessage = {
          sender: sendername,   // bug，如果rolename更改，全局池里没有改变，导致历史上下文不对应
          id: messageObj.id,
          message,
          originalReply,
          content,
          target: targetrole,
          timestamp: Date.now()
        };
        room.globalMessages.push(processedMessage);
      
        rooms[roomCode] = room;    // 逻辑上可以省略，但保险起见
        this.isProcessing = false;      // 标记处理完成
        const writeResult = visitDatajson('write');
        if (!writeResult.success) {
          console.error('数据保存失败:', writeResult.error);
        }
      } catch (error) {
        console.error('API调用失败:', error);
      }
    }
  }
}

// WebSocket消息处理器
// 接收原始消息 -> 解析 -> 路由到对应处理函数 -> 异常捕获
/**
 * [功能] WebSocket消息统一调度器
 * [处理流程]
 * 1. 连接状态验证 -> 2. 消息解析 -> 3. 类型路由 -> 4. 异常捕获
 * [容错机制]
 * - 非OPEN状态连接拒绝处理
 * - 消息格式错误返回标准错误码
 * - 系统级错误日志记录
 */
function handleWebSocketMessage(ws, rawMessage) {
  try {
    if (ws.readyState !== ws.OPEN) {
      console.warn('尝试在非OPEN状态(%s)处理消息', ws.readyState);
      return;
    }
    
    const message = JSON.parse(rawMessage);
    
    switch (message.type) {
      case MessageTypes.REQUEST_UPDATE:
        handleRequestUpdate(ws, message);
        onlineset(message.roomCode, message.accountID);
        break;
      case MessageTypes.SEND_MESSAGE: // 消息发送事件
        handleSendMessage(ws, message);
        onlineset(message.roomCode, message.senderID);
        break;
    }
  } catch (error) {
    console.error('WebSocket消息处理错误:', error);
    ws.send(JSON.stringify({
      type: 'ERROR',
      message: '消息处理失败: ' + error.message
    }));
  }
}

// 处理消息发送事件
/* messageObj = { type: 'SEND_MESSAGE',
                  roomCode: roomCode,
                  sendername: roleName,
                  message: message,
                  messageId: messageId    }*/
async function handleSendMessage(ws, messageObj) {
  if (!messageObj || !messageObj.roomCode || !messageObj.senderID || !messageObj.message) {
    ws.send(JSON.stringify({
      type: 'ERROR',
      message: '消息格式错误：缺少必要字段'
    }));
    return;
  }
  
  const { roomCode, senderID, message, messageId } = messageObj;
  const room = rooms[roomCode];
  if (!room) {
    ws.send(JSON.stringify({
      type: 'ERROR',
      message: '房间不存在'
    }));
    return;
  }

  MediationCenter.queue.push({
    roomCode,
    senderID,
    message,
    id: messageId,
    processed: false
  });

  MediationCenter.processQueue();
  while (MediationCenter.isProcessing) await new Promise(resolve => setTimeout(resolve, 100));

  // 监听处理结果
  const responseData = {
    type: 'REPLY_MESSAGE',
    success: false,
    reply: '服务器繁忙，请稍后再试。',
    replyid: messageId,
    messageId
  };
  const processed = room.globalMessages.find(m => m.id === messageId);
  if (processed) {
    responseData.success = true;
    responseData.reply = processed.content;
    ws.send(JSON.stringify(responseData));
  }
}

// 处理更新请求事件
function handleRequestUpdate(ws, { roomCode, accountID }) {
  const room = rooms[roomCode];
  if (!room) return;
  if (!room.members.find(u => u.roleID === accountID)) return;
  // 直接发送当前房间状态
  ws.send(JSON.stringify({
    type: 'ROOM_UPDATE',
    room    //其他member的描述需要清空，全局消息池需要筛选
  }));
}

// 在线状态更新
function onlineset(roomCode, accountID, online = true) {
  const room = rooms[roomCode];
  if (!room) return;
  if (!room.members.find(u => u.roleID === accountID)) return;
  const memberindex = room.members.findIndex(u => u.roleID === accountID);  
  if (memberindex == -1) {
    return res.status(404).json({ success: false, message: '未在房间内登记角色信息' });
  } 
  rooms[roomCode].members[memberindex].online = online;
  const writeResult = visitDatajson('write');
  if (!writeResult.success) {
    console.error('数据保存失败:', writeResult.error);
  }
}

// 广播房间状态更新
function broadcastRoomUpdate(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const update = JSON.stringify({
    type: 'ROOM_UPDATE',
    room
  });

  // 遍历所有客户端连接
  if (room.clients) {
    room.clients.forEach(client => {
      if (client.ws && client.ws.readyState === client.ws.OPEN) {
        client.ws.send(update);
      }
    });
  }
  const writeResult = visitDatajson('write');
  if (!writeResult.success) {
    console.error('数据保存失败:', writeResult.error);
  }
}

// 广播系统消息
function broadcastSystemMessage(roomCode, message) {
  if (!CONFIG.enableSystemBroadcast) return;
  const room = rooms[roomCode];
  
  if (room && room.clients) {
    const systemMessage = JSON.stringify({
      type: 'SYSTEM_MESSAGE',
      ...message
    });
    
    room.clients.forEach(client => {
      if (client.ws && client.ws.readyState === client.ws.OPEN) {
        client.ws.send(systemMessage);
      }
    });
  }
  const writeResult = visitDatajson('write');
  if (!writeResult.success) {
    console.error('数据保存失败:', writeResult.error);
  }
}

function BackgroundMessageUpdate(roomCode) {
  const room = rooms[roomCode];
  // 清空BackgroundMessage
  room.BackgroundMessage = [];
  room.BackgroundMessage.push({
    role: 'user',
    content: room.mediatorInstruction
  });
  if (room.members.some(role => role.selfIntroduction || (role.description && role.description.length > 0))) {
    for (let i = 0; i < room.members.length; i++) {
      const selfname = `${room.code}_${room.members[i].roleID}`; 
      room.BackgroundMessage.push({
        role: 'user',
        content: `${selfname}的自我介绍：${room.members[i].selfIntroduction}`
      });
      for (let j = 0; j < room.members[i].description.length; j++) {
        const othersname = `${room.code}_${room.members[i].description[j].tagID}`; 
        room.BackgroundMessage.push({
          role: 'user',
          content: `${selfname}对` + `${othersname}的描述：` +
          `${room.members[i].description[j].relationshipDesc}`
        });
      }
    }
  }
  rooms[roomCode] = room;
  const writeResult = visitDatajson('write');
  if (!writeResult.success) {
    console.error('数据保存失败:', writeResult.error);
  }
}

/**
 * [功能] 用户加入聊天室核心逻辑
 * @param ws - WebSocket连接对象，维护长连接状态
 * @param roomCode 房间标识符，采用6位混合编码格式
 * @param accountname 用户昵称，'admin'具有权限覆盖特性
 * [业务逻辑]
 * 1. 用户ID生成：时间戳+随机数组合确保唯一性
 * 2. 管理员权限：后加入的admin会强制踢出原有admin
 * 3. 状态广播：实时推送用户列表变更到所有客户端
 */

// 启用 CORS 和 JSON 解析，允许跨域请求并解析JSON格式的请求体
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error('服务器错误:', err.stack);
  res.status(500).json({ message: '内部服务器错误' });
});
app.use(express.static('public'));
app.use(bodyParser.json());

// 创建房间接口（修改部分）
app.post('/create-room', async (req, res) => {
  try {
    // 添加房间数量上限检查
    if (Object.keys(rooms).length >= 100) {
      return res.status(400).json({ 
        success: false,
        message: '房间数量已达上限（100间），无法创建新房间'
      });
    }

    // 解构所有必要参数
    const { accountID, roleName, roomName, password, prompt, mode } = req.body;
    const accountIndex = accounts.findIndex(u => u.id === accountID);  
    if (accountIndex == -1) {
      return res.status(404).json({ success: false, message: '用户未注册' });
    }

    // 房间名称唯一性校验
    const isNameUnique = !Object.values(rooms).some(r => r.name === roomName);
    if (!isNameUnique) {
      return res.status(400).json({ 
        success: false,
        message: '房间名称已存在，请重新命名'
      });
    }
    
    // 生成唯一房间码
    const roomCode = generateRoomCode(rooms);
    
    // 房间数据结构（新增clients字段）
    const newRoom = {
      code: roomCode,
      name: roomName,
      owner: accountID,
      password: password,
      mediatorInstruction: prompt,
      mediatorMode: parseInt(mode) || 1,
      BackgroundMessage: [],
      members: [{
        roleID: accountID,
        roleName: roleName,
        selfIntroduction: '',
        description: [],
        online: false,
        joinTime: new Date().toISOString(),
        lastChecked: Date.now()
      }],
      created: new Date().toISOString(),
      globalMessages: [],
      clients: [] // 新增：存储WebSocket客户端连接
    };

    rooms[roomCode] = newRoom;
    accounts[accountIndex].joinedRooms.push({
      roomCode,
      roomName,
      roleName,
      password,
      lastAccessed: new Date().toISOString()
    });
    // 初始化房间背景信息
    BackgroundMessageUpdate(roomCode);
    const writeResult = visitDatajson('write');
    if (!writeResult.success) {
      console.error('数据保存失败:', writeResult.error);
    }
    // 在创建房间接口的响应中添加重定向逻辑
    res.json({ 
      success: true, 
      roomCode,
      accountID
      //redirect: `/chatwindow.html?accountID=${accountID}`
    });
  } catch (error) {
    console.error('创建房间失败:', error);
    res.status(500).json({ success: false, message: '服务器错误' });
  }
});

// 获取用户房间接口
// 添加获取用户房间列表接口
app.get('/account/rooms', (req, res) => {
  const accountID = req.query.accountID;
  
  try {
    // 根据 accountID 找出 accounts 中对应的元素
    const joinIndex = accounts.findIndex(u => u.id === accountID);
    if (joinIndex === -1) {
      return res.status(404).json({ success: false, message: '未找到对应的用户' });
    } else {
      const accountName = accounts[joinIndex].accountname; // 提取用户的房间列表
      const joinedRooms = accounts[joinIndex].joinedRooms; // 提取用户的房间列表
      res.json({ success: true, accountName, joinedRooms }); // 返回用户的房间列表
    }
  } catch (error) {
    console.error('获取房间列表失败:', error);
    res.status(500).json({ success: false });
  }
});

app.post('/register', async (req, res) => {
  try {
    const { accountname, email, password } = req.body;
    
    if (accounts.some(u => u.email === email)) {
      return res.status(400).json({ success: false, message: '邮箱已被注册' });
    }
    
    if (accounts.some(u => u.accountname === accountname)) {
      return res.status(400).json({ success: false, message: '用户名已存在' });
    }
    
    const account = {
      id: generateUniqueId(accounts), // 生成唯一用户ID
      accountname,
      email,
      password,
      createdAt: new Date().toISOString(),
      joinedRooms: []
    };
    
    accounts.push(account);
    const writeResult = visitDatajson('write');
    if (!writeResult.success) {
      console.error('数据保存失败:', writeResult.error);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('注册错误:', error);
    res.status(500).json({ success: false, message: '服务器错误' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const account = accounts.find(u => u.email === email);
    
    if (!account || password !== account.password) {
      return res.status(401).json({ success: false, message: '邮箱或密码错误' });
    }
    
    const sessionToken = randomUUID();    // 生成随机UUID作为会话令牌
    sessions[sessionToken] = { // 将会话令牌存储在服务器端
      accountId: account.id,
      expires: Date.now() + 3600000 // 1小时有效期
    };
    
    res.json({
      success: true,
      sessionToken,
      account: {
        id: account.id,
        name: account.accountname
      }
    });
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ success: false, message: '服务器错误' });
  }
});

// 加入房间（POST 请求）
app.post('/join', async (req, res) => {
  try {
    // 从请求体中正确解构roleName参数
    const { roomCode, roleName, password, accountID } = req.body; // 修复：添加roleName参数
    const room = rooms[roomCode];
    
    // 验证房间存在性
    if (!room) {
      return res.status(404).json({ success: false, message: '房间不存在' });
    }
    
    // 验证房间口令
    if (room.password !== password) {
      return res.status(401).json({ success: false, message: '房间口令错误' });
    }

    const accountIndex = accounts.findIndex(u => u.id === accountID);  
    if (accountIndex == -1) {
      return res.status(404).json({ success: false, message: '用户未注册' });
    } 

    const existmember = room.members.find(u => u.roleID === accountID);  
    if (!existmember) {
      room.members.push({
        roleID: accountID,
        roleName: roleName, // 使用从请求体获取的roleName
        selfIntroduction: '', // 添加默认值
        description: [], // 添加默认值
        online: true, // 添加默认在线状态
        joinTime: new Date().toISOString(),
        lastChecked: Date.now() // 添加默认时间戳
      });
      rooms[roomCode] = room; // 更新房间引用
      accounts[accountIndex].joinedRooms.push({
        roomCode: roomCode,
        roomName: room.name,
        roleName: roleName,
        password: room.password,
        lastAccessed: new Date().toISOString()
      });
    } 

    // 通过WebSocket连接后续处理用户注册
    // 实际用户注册将在收到WS的JOIN_ROOM消息后统一处理
    broadcastSystemMessage(roomCode, {
      type: 'SYSTEM_MESSAGE',
      message: `成员 ${roleName} 加入了房间`,
      timestamp: Date.now()
    });
  
    // 初始化房间背景信息
    if (room.BackgroundMessage.length === 0) {
      BackgroundMessageUpdate(roomCode);
    }
    const writeResult = visitDatajson('write');
    if (!writeResult.success) {
      console.error('数据保存失败:', writeResult.error);
    }
    // 返回历史记录和用户列表
    res.json({
      success: true,
    });   // 返回房间信息
  } catch (error) {
    console.error('加入错误:', error);
    res.status(500).json({ success: false, message: '服务器错误' });
  }
});

// 进入房间获取信息，进行初始化（POST 请求）
app.post('/room-info', async (req, res) => {
  try {
    const { roomCode, accountID } = req.body;
    const room = rooms[roomCode]; // 获取最新房间引用
    // 验证房间存在性
    if (!room) {
      return res.status(404).json({ success: false, message: '房间不存在' });
    }

    const accountIndex = accounts.findIndex(u => u.id === accountID);  
    if (accountIndex == -1) {
      return res.status(404).json({ success: false, message: '用户未注册' });
    } 

    onlineset(roomCode, accountID);
    const sendername = `${roomCode}_${accountID}`;
    const myhistorymessages = room.globalMessages.filter(msg => msg.sender === sendername || msg.target === sendername);
    const mymemberinfo = room.members.find(u => u.roleID === accountID);
    const memberList = room.members.map(member => {
      return {
        roleID: member.roleID,
        roleName: member.roleName,
        online: member.online,
        joinTime: member.joinTime,
        lastChecked: member.lastChecked
      };
    })
    const writeResult = visitDatajson('write');
    if (!writeResult.success) {
      console.error('数据保存失败:', writeResult.error);
    }
    // 返回历史记录和用户列表
    res.json({
      success: true,
      roomName: room.name,
      password: room.password,
      mymemberinfo,
      memberList,
      myhistorymessages,
    });   // 返回房间信息
  } catch (error) {
    console.error('初始化错误:', error);
    res.status(500).json({ success: false, message: '服务器错误' });
  }
});

// 用户信息更新接口
app.post('/update-settings', async (req, res) => {
  const { roomCode, newmemberinfo } = req.body;
  const room = rooms[roomCode];
  const accountID = newmemberinfo.roleID;
  if (!room) {
    return res.status(404).json({ success: false, message: '房间不存在' });
  }

  // 使用箭头函数隐式返回简化成员更新逻辑
  const memberindex = room.members.findIndex(member => member.roleID === accountID );
  room.members[memberindex] = newmemberinfo;
  const accountindex = accounts.findIndex(u => u.id === accountID );
  const roomindex = accounts[accountindex].joinedRooms.findIndex(u => u.roomCode === roomCode );
  accounts[accountindex].joinedRooms[roomindex].roleName = newmemberinfo.roleName;
  BackgroundMessageUpdate(roomCode);
  onlineset(roomCode, accountID);
  const writeResult = visitDatajson('write');
  if (!writeResult.success) {
    console.error('数据保存失败:', writeResult.error);
  }
  res.json({ success: true });
});

// 退出房间（POST 请求）
app.post('/leave', (req, res) => {
  const { roomCode, accountID } = req.body;
  if (!roomCode || !accountID) {
    return res.status(400).json({ success: false, message: '房间号和账户不能为空' });
  }

  const room = rooms[roomCode];
  if (!room) {
    return res.status(404).json({ success: false, message: '房间不存在' });
  }
  onlineset(roomCode, accountID, false);
// 广播用户列表更新
  broadcastRoomUpdate(roomCode);
  const writeResult = visitDatajson('write');
  if (!writeResult.success) {
    console.error('数据保存失败:', writeResult.error);
  }
  res.json({ success: true });
});

// 添加房间名称唯一性校验逻辑
/**
 * 生成唯一两位数字房间码
 * @param {Object} existingRooms - 现有房间对象
 * @returns {string} 唯一房间码
 */
function generateRoomCode(existingRooms) {
  let code;
  do {
    // 生成00-99之间的随机数
    code = Math.floor(Math.random() * 100).toString().padStart(2, '0');
  } while (Object.values(existingRooms).some(r => r.code === code));
  return code;
}

/*
 * 功能：访问数据存储文件（data/data.json）
 * 参数：
 *   action - 操作类型（'read'：读取数据；'write'：写入数据）
 * 返回：
 *   read操作：{ accounts: 账户列表, rooms: 房间列表 }
 *   write操作：成功返回 { success: true }, 失败返回 { success: false, error: 错误信息 }
 */
// 定义一个函数，用于读取、写入或初始化data.json文件中的数据
function visitDatajson(action = 'read') {
  const fs = require('fs'); // 引入文件系统模块
  const path = require('path'); // 引入路径模块
  const DATA_FILE_PATH = path.join(__dirname, 'data', 'data.json'); // 兼容Windows路径

  try {
    if (action === 'read') {
      // 读取并解析数据文件
      const dataContent = fs.readFileSync(DATA_FILE_PATH, 'utf8'); // 读取文件内容
      const { accounts, rooms } = JSON.parse(dataContent); // 解析文件内容
      return { accounts, rooms }; // 返回解析后的数据
    } else if (action === 'write') {
      // 将全局变量写入文件（注意：需确保accounts和rooms是当前最新状态）
      const dataToSave = { accounts, rooms }; // 构造要写入的数据
      fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(dataToSave, null, 2), 'utf8'); // 将数据写入文件
      return { success: true }; // 返回成功信息
    } else if (action === 'clear') {
      // 初始化账户数据（改为数组形式，与读取逻辑的 accounts 键匹配）
      const accountsInit = [{
        id: '12345678',
        accountname: '测试账户',
        email: '111',
        password: '111',
        createdAt: new Date().toISOString(),
        joinedRooms: []
      }];
      // 初始化房间数据（与读取逻辑的 rooms 键匹配）
      const roomsInit = {};
      // 关键修复：将键名改为 accounts 和 rooms
      const dataToSave = { accounts: accountsInit, rooms: roomsInit };
      fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(dataToSave, null, 2), 'utf8');
      return { success: true };
    } else {
      throw new Error(`不支持的操作类型: ${action}`);
    }
  } catch (error) {
    if (action === 'read' && error.code === 'ENOENT') {
      // 文件不存在时返回初始结构（与用户提供的data.json初始内容一致）
      return { accounts: [], rooms: {} };
    }
    return { success: false, error: error.message };
  }
}

// WebSocket连接管理（新增连接/断开处理）
wss.on('connection', (ws, req) => {
  let currentRoomCode = null; // 记录当前连接所属房间

  ws.on('message', async (message) => {
    // ... existing message处理逻辑 ...

    // 新增：处理JOIN_ROOM消息（需前端配合发送）
    if (message.type === MessageTypes.JOIN_ROOM) {
      const { roomCode, accountID } = message;
      const room = rooms[roomCode];
      if (room) {
        currentRoomCode = roomCode;
        // 将客户端连接添加到房间的clients数组
        room.clients.push({ ws, accountID });
        // 更新用户在线状态
        const member = room.members.find(m => m.roleID === accountID);
        if (member) member.online = true;
        broadcastRoomUpdate(roomCode); // 广播房间状态更新
        const writeResult = visitDatajson('write');
        if (!writeResult.success) {
          console.error('数据保存失败:', writeResult.error);
        }
      }
    }
  });

  // 新增：连接关闭时清理资源
  // WebSocket连接关闭处理（补充修改）
  ws.on('close', () => {
    if (currentRoomCode) {
      const room = rooms[currentRoomCode];
      if (room) {
        // ... existing clients清理逻辑 ...
        
        // 遍历成员找到离线用户（通过clients数组判断）
        room.members.forEach(member => {
          const isOnline = room.clients.some(client => client.accountID === member.roleID);
          member.online = isOnline; // 更新在线状态
        });
        
        broadcastRoomUpdate(currentRoomCode); // 广播更新
        const writeResult = visitDatajson('write');
        if (!writeResult.success) {
          console.error('数据保存失败:', writeResult.error);
        }
      }
    }
  });
});

// 添加健康检查接口
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});
