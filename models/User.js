const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  roomCode: { type: String, required: true },
  isMediator: { type: Boolean, default: false },
  joinedAt: { type: Date, default: Date.now },
  lastActive: Date,
  isMuted: { type: Boolean, default: false },
  ipAddress: String
});

module.exports = mongoose.model('User', userSchema);