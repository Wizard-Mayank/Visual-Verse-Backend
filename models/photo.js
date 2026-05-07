const mongoose = require('mongoose');

const PhotoSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    albumId: {
      type: String,
      required: true,
      default: 'ROOT',
      index: true
    },
    filename: {
      type: String,
      required: true
    },
    photoURL: {
      type: String,
      required: true
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('Photo', PhotoSchema);
