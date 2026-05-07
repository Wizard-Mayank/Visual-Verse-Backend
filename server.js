const express = require("express");
const mongoose = require("mongoose");
const authRoutes = require("./routes/auth");
const cors = require("cors");
const { GridFSBucket } = require("mongodb");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5175",
    credentials: false,
  }),
);

const PORT = process.env.PORT || 5000;
const DB_URL = process.env.MONGODB_URI;

if (!DB_URL) {
  throw new Error("MONGODB_URI is missing. Add it to your environment.");
}

mongoose
  .connect(DB_URL)
  .then(() => {
    console.log("MongoDB connected");

    const conn = mongoose.connection;
    app.locals.bucket = new GridFSBucket(conn.db, {
      bucketName: "images",
    });

    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  })
  .catch((err) => console.log("MongoDB connection error:", err));

app.get("/healthz", (req, res) => {
  res.status(200).json({ ok: true });
});

app.use("/api", authRoutes);
