const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  roomCode: { type: String, required: true },
  sender: { type: String, required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  isDeleted: { type: Boolean, default: false },
  attachments: [{
    type: { type: String, enum: ['image', 'file'] },
    url: String
  }]
});

module.exports = mongoose.model('Message', messageSchema);