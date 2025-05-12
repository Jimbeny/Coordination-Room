// 生成一个独一无二的ID，确保ID在user列表中是唯一的
function generateUniqueId(users) {
  let id;
  let isUnique = false;

  while (!isUnique) {
    id = Math.floor(10000000 + Math.random() * 90000000).toString();
    isUnique = !users.some(user => user.id === id);
  }

  return id;
}

module.exports = generateUniqueId;