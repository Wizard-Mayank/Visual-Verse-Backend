const mongoose = require('mongoose');

const AlbumSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    }
  },
  {
    timestamps: true
  }
);

AlbumSchema.index({ userId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Album', AlbumSchema);
