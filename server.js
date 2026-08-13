import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import admin from "firebase-admin";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const requireFirebaseAuth =
  String(process.env.REQUIRE_FIREBASE_AUTH || "true").toLowerCase() === "true";

app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: "1mb" }));

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

let firebaseReady = false;
try {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey: privateKey.replace(/\\n/g, "\n")
      })
    });
    firebaseReady = true;
  }
} catch (error) {
  console.error("Firebase Admin initialization failed:", error.message);
}

async function requireUser(req, res, next) {
  if (!requireFirebaseAuth) return next();
  if (!firebaseReady) {
    return res.status(503).json({ error: "Authentication service is not configured." });
  }

  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7) : "";

  if (!token) return res.status(401).json({ error: "Authentication required." });

  try {
    req.user = await admin.auth().verifyIdToken(token);
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired authentication token." });
  }
}

cloudinary.config({
  cloud_name: required("CLOUDINARY_CLOUD_NAME"),
  api_key: required("CLOUDINARY_API_KEY"),
  api_secret: required("CLOUDINARY_API_SECRET"),
  secure: true
});

const GEMINI_API_KEY = required("GEMINI_API_KEY");
const GEMINI_MODEL = required("GEMINI_MODEL");

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "nexu-backend" });
});

app.post("/api/gemini/stream", requireUser, async (req, res) => {
  try {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(120000)
      }
    );

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text();
      return res.status(upstream.status || 502).json({
        error: "Gemini request failed.",
        detail: detail.slice(0, 1000)
      });
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
    return res.end();
  } catch (error) {
    console.error("Gemini streaming error:", error.message);
    if (!res.headersSent) return res.status(502).json({ error: "Gemini service unavailable." });
    return res.end();
  }
});

app.post("/api/gemini/session", requireUser, async (req, res) => {
  try {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(30000)
      }
    );

    const text = await upstream.text();
    return res.status(upstream.status).type("application/json").send(text);
  } catch (error) {
    console.error("Gemini session error:", error.message);
    return res.status(502).json({ error: "Gemini service unavailable." });
  }
});

function resourceTypeFor(input) {
  if (input === "video" || input === "audio") return "video";
  if (input === "raw") return "raw";
  return "image";
}

app.post("/api/upload", requireUser, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file supplied." });

  const resourceType = resourceTypeFor(String(req.body.resourceType || "image"));
  const allowed = {
    image: ["image/jpeg","image/png","image/gif","image/webp","image/heic"],
    video: ["video/mp4","video/webm","video/quicktime","video/3gpp",
            "audio/webm","audio/ogg","audio/mpeg","audio/mp4","audio/wav"],
    raw: ["application/pdf","application/zip","application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
  };

  if (resourceType !== "raw" && !allowed[resourceType].includes(req.file.mimetype)) {
    return res.status(415).json({ error: "Unsupported file type." });
  }

  try {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({
        resource_type: resourceType,
        folder: "nexu-chat",
        use_filename: false,
        unique_filename: true,
        overwrite: false
      }, (error, result) => error ? reject(error) : resolve(result));
      stream.end(req.file.buffer);
    });

    return res.json({
      secure_url: result.secure_url,
      public_id: result.public_id,
      resource_type: result.resource_type,
      bytes: result.bytes,
      format: result.format
    });
  } catch (error) {
    console.error("Cloudinary upload failed:", error.message);
    return res.status(502).json({ error: "Cloudinary upload failed." });
  }
});

app.use((error, _req, res, _next) => {
  if (error?.message === "Origin not allowed") {
    return res.status(403).json({ error: "Origin not allowed." });
  }
  if (error?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large." });
  }
  console.error(error);
  return res.status(500).json({ error: "Server error." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Nexu backend listening on ${PORT}`);
});
