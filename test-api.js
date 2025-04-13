require('dotenv').config();
const { SILICONFLOW_CONFIG } = require('./server.js');

(async () => {
  try {
    const response = await fetch(`${SILICONFLOW_CONFIG.baseUrl}/users/me`, {
      headers: {
        Authorization: `Bearer ${process.env.SILICONFLOW_API_KEY}`
      }
    });
    console.log('HTTP状态码:', response.status);
    console.log('响应内容:', await response.text());
  } catch (error) {
    console.error('测试失败:', error);
  }
})();