const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const passport = require('passport');
const User = require('../models/user');
const Album = require('../models/album');
const Photo = require('../models/photo');
require('./passport');

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });
const JWT_SECRET = process.env.JWT_SECRET || 'local-dev-secret-change-me';

const toClientUser = (userDoc) => ({
  uid: userDoc._id.toString(),
  username: userDoc.username,
  displayName: userDoc.username,
  email: userDoc.email,
  photoURL: null
});

const createToken = (userDoc) =>
  jwt.sign({ sub: userDoc._id.toString(), email: userDoc.email }, JWT_SECRET, { expiresIn: '7d' });

const authRequired = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ msg: 'Unauthorized' });
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (error) {
    return res.status(401).json({ msg: 'Invalid token' });
  }
};

const makeImageUrl = (req, filename) => `${req.protocol}://${req.get('host')}/api/image/${filename}`;

async function uploadToGridFs(bucket, filename, buffer) {
  await new Promise((resolve, reject) => {
    const stream = bucket.openUploadStream(filename);
    stream.on('finish', resolve);
    stream.on('error', reject);
    stream.end(buffer);
  });
}

async function deleteFromGridFs(db, bucket, filename) {
  const fileDoc = await db.collection('images.files').findOne({ filename });
  if (fileDoc) {
    await bucket.delete(fileDoc._id);
  }
}

router.get('/auth/google', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ msg: 'Google auth is not configured' });
  }
  return passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

router.get('/auth/google/callback', passport.authenticate('google', { session: false }), (req, res) => {
  const token = createToken(req.user);
  const redirectTo = process.env.FRONTEND_URL || '/';
  return res.redirect(`${redirectTo}?token=${token}`);
});

router.post('/logout', (req, res) => res.status(200).json({ msg: 'Logged out' }));

const updatePasswordHandler = async (req, res) => {
  const { email, username, newPassword } = req.body;
  if (!email || !username || !newPassword) {
    return res.status(400).json({ msg: 'email, username and newPassword are required' });
  }
  try {
    const user = await User.findOne({ email, username });
    if (!user) return res.status(404).json({ msg: 'User not found' });
    user.password = newPassword;
    await user.save();
    return res.status(200).json({ msg: 'Password updated successfully' });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ msg: 'Server error' });
  }
};

router.post('/forgot-password', updatePasswordHandler);
router.post('/forget-password', updatePasswordHandler);

router.post('/signup', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ msg: 'username, email and password are required' });
  }
  try {
    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) return res.status(400).json({ msg: 'User already exists' });

    const user = new User({ username, email, password });
    await user.save();
    const token = createToken(user);
    return res.status(201).json({ msg: 'User created successfully', token, user: toClientUser(user) });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ msg: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ msg: 'email and password are required' });
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: 'Invalid credentials' });

    const valid = await user.comparePassword(password);
    if (!valid) return res.status(400).json({ msg: 'Invalid credentials' });

    const token = createToken(user);
    return res.status(200).json({ msg: 'Login successful', token, user: toClientUser(user) });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ msg: 'Server error' });
  }
});

router.get('/user', authRequired, async (req, res) => {
  try {
    const user = await User.findById(req.auth.sub);
    if (!user) return res.status(404).json({ msg: 'User not found' });
    return res.status(200).json(toClientUser(user));
  } catch (error) {
    return res.status(500).json({ msg: 'Server error' });
  }
});

router.get('/albums/:uid', authRequired, async (req, res) => {
  try {
    const { uid } = req.params;
    if (req.auth.sub !== uid) return res.status(403).json({ msg: 'Forbidden' });
    const albums = await Album.find({ userId: uid }).sort({ createdAt: -1 });
    const payload = albums.map((a) => ({ id: a._id.toString(), data: { name: a.name } }));
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(500).json({ msg: 'Server error' });
  }
});

router.post('/albums', authRequired, async (req, res) => {
  try {
    const { albumName, uid } = req.body;
    if (!albumName || !uid) return res.status(400).json({ msg: 'albumName and uid are required' });
    if (req.auth.sub !== uid) return res.status(403).json({ msg: 'Forbidden' });
    const album = await Album.create({ name: albumName, userId: uid });
    return res.status(201).json({ id: album._id.toString(), data: { name: album.name } });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ msg: 'Album already exists' });
    return res.status(500).json({ msg: 'Server error' });
  }
});

router.delete('/albums/:albumId', authRequired, async (req, res) => {
  try {
    const { albumId } = req.params;
    const album = await Album.findById(albumId);
    if (!album) return res.status(404).json({ msg: 'Album not found' });
    if (album.userId.toString() !== req.auth.sub) return res.status(403).json({ msg: 'Forbidden' });

    const photos = await Photo.find({ albumId: albumId, userId: req.auth.sub });
    const bucket = req.app.locals.bucket;
    const db = mongoose.connection.db;
    await Promise.all(photos.map((photo) => deleteFromGridFs(db, bucket, photo.filename)));
    await Photo.deleteMany({ albumId: albumId, userId: req.auth.sub });
    await album.deleteOne();
    return res.status(200).json({ msg: 'Album deleted' });
  } catch (error) {
    return res.status(500).json({ msg: 'Server error' });
  }
});

router.post('/upload', authRequired, upload.array('photos', 3), async (req, res) => {
  try {
    const { albumId = 'ROOT', uid } = req.body;
    const files = req.files || [];
    if (!uid) return res.status(400).json({ msg: 'uid is required' });
    if (req.auth.sub !== uid) return res.status(403).json({ msg: 'Forbidden' });
    if (files.length === 0) return res.status(400).json({ msg: 'No files uploaded' });
    if (files.length > 3) return res.status(400).json({ msg: 'Only 3 images can be uploaded' });

    const bucket = req.app.locals.bucket;
    const uploaded = [];
    for (const file of files) {
      const filename = `${crypto.randomBytes(16).toString('hex')}${path.extname(file.originalname)}`;
      await uploadToGridFs(bucket, filename, file.buffer);
      const photo = await Photo.create({
        name: file.originalname,
        userId: uid,
        albumId,
        filename,
        photoURL: makeImageUrl(req, filename)
      });
      uploaded.push({
        id: photo._id.toString(),
        data: { name: photo.name, photoURL: photo.photoURL, albumId: photo.albumId }
      });
    }
    return res.status(201).json({ msg: 'Images uploaded successfully', photos: uploaded });
  } catch (error) {
    return res.status(500).json({ msg: 'Server error' });
  }
});

router.delete('/photos/:id', authRequired, async (req, res) => {
  try {
    const photo = await Photo.findById(req.params.id);
    if (!photo) return res.status(404).json({ msg: 'Photo not found' });
    if (photo.userId.toString() !== req.auth.sub) return res.status(403).json({ msg: 'Forbidden' });

    const bucket = req.app.locals.bucket;
    const db = mongoose.connection.db;
    await deleteFromGridFs(db, bucket, photo.filename);
    await photo.deleteOne();
    return res.status(200).json({ msg: 'Photo deleted' });
  } catch (error) {
    return res.status(500).json({ msg: 'Server error' });
  }
});

router.get('/photos/root', authRequired, async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ msg: 'uid is required' });
    if (req.auth.sub !== uid) return res.status(403).json({ msg: 'Forbidden' });
    const photos = await Photo.find({ userId: uid, albumId: 'ROOT' }).sort({ createdAt: -1 });
    const payload = photos.map((p) => ({
      id: p._id.toString(),
      data: { name: p.name, photoURL: p.photoURL, albumId: p.albumId }
    }));
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(500).json({ msg: 'Server error' });
  }
});

router.get('/photos/album', authRequired, async (req, res) => {
  try {
    const { albumId } = req.query;
    if (!albumId) return res.status(400).json({ msg: 'albumId is required' });
    const photos = await Photo.find({ userId: req.auth.sub, albumId }).sort({ createdAt: -1 });
    const payload = photos.map((p) => ({
      id: p._id.toString(),
      data: { name: p.name, photoURL: p.photoURL, albumId: p.albumId }
    }));
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(500).json({ msg: 'Server error' });
  }
});

router.get('/image/:filename', (req, res) => {
  const { filename } = req.params;
  const bucket = req.app.locals.bucket;
  try {
    const downloadStream = bucket.openDownloadStreamByName(filename);
    downloadStream.on('data', (chunk) => res.write(chunk));
    downloadStream.on('end', () => res.end());
    downloadStream.on('error', () => res.status(404).json({ msg: 'Image not found' }));
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ msg: 'Server error' });
  }
});

module.exports = router;
