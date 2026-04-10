// ================= LOAD ENV =================
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// ================= IMPORTS =================
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const mysql      = require('mysql2');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 5000;

// ================= DEBUG =================
console.log("DB_HOST:", process.env.DB_HOST);
console.log("DB_USER:", process.env.DB_USER);
console.log("DB_PASS:", process.env.DB_PASS);
console.log("DB_NAME:", process.env.DB_NAME);

// ================= MIDDLEWARE =================
app.use(cors());
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..')));

// ================= MYSQL =================
const db = mysql.createConnection({
    host:     process.env.DB_HOST || "localhost",
    user:     process.env.DB_USER || "root",
    password: process.env.DB_PASS || "",
    database: process.env.DB_NAME
});

db.connect(err => {
    if (err) {
        console.log("❌ DB Error:", err.message);
    } else {
        console.log("✅ MySQL Connected");
        fixAndCreateTables();
    }
});

// ================= FIX & CREATE TABLES =================
function fixAndCreateTables() {

    // ✅ FIX: Drop old user table structure issues and align with actual DB schema
    // We do NOT drop the table — we just ensure the columns exist
    db.query(`
        CREATE TABLE IF NOT EXISTS user (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            name       VARCHAR(100),
            mobile     VARCHAR(20),
            email      VARCHAR(100) UNIQUE,
            password   VARCHAR(255),
            otp        VARCHAR(6),
            otp_expiry DATETIME,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) console.log("⚠️ user table note:", err.message);
        else console.log("✅ user table ready");
    });

    db.query(`
        CREATE TABLE IF NOT EXISTS fuel_requests (
            id             INT AUTO_INCREMENT PRIMARY KEY,
            vehicle_number VARCHAR(50),
            fuel_type      VARCHAR(50),
            quantity       DECIMAL(10,2),
            location       VARCHAR(255),
            pump_name      VARCHAR(255),
            payment_method VARCHAR(100),
            txn_id         VARCHAR(100),
            payment_status VARCHAR(50) DEFAULT 'Pending',
            status         VARCHAR(50) DEFAULT 'Pending',
            cancel_reason  VARCHAR(255),
            cancelled_at   TIMESTAMP NULL,
            created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.query(`
        CREATE TABLE IF NOT EXISTS support_tickets (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            ticket_id   VARCHAR(50) UNIQUE,
            user_name   VARCHAR(100),
            order_id    VARCHAR(100),
            problem     VARCHAR(255),
            description TEXT,
            status      VARCHAR(50) DEFAULT 'Open',
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

// ================= EMAIL =================
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false, 
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    tls: {
        rejectUnauthorized: false
    }
});
// ================= OTP STORE (in-memory) =================
const otpStore = {};

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// ================= AUTH ROUTES =================

// ── Register ──
app.post('/api/register', (req, res) => {
    const { name, mobile, email, password } = req.body;

    if (!name || !mobile || !email || !password) {
        return res.json({ success: false, error: "All fields are required." });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // ✅ Check if email already exists before inserting
    db.query("SELECT id FROM user WHERE email = ?", [normalizedEmail], (err, result) => {
        if (err) return res.json({ success: false, error: err.message });

        if (result.length > 0) {
            return res.json({ success: false, reason: "already_registered", error: "Email already registered." });
        }

        db.query(
            "INSERT INTO user (name, mobile, email, password) VALUES (?, ?, ?, ?)",
            [name, mobile, normalizedEmail, password],
            (err) => {
                if (err) return res.json({ success: false, error: err.message });
                console.log("✅ New user registered:", normalizedEmail);
                res.json({ success: true });
            }
        );
    });
});

// ── Login ──
app.post('/api/login', (req, res) => {
    const { email, mobile, password } = req.body;

    const normalizedEmail = email ? email.toLowerCase().trim() : null;

    const sql = normalizedEmail
        ? "SELECT * FROM user WHERE email = ? AND password = ?"
        : "SELECT * FROM user WHERE mobile = ? AND password = ?";

    const param = normalizedEmail || mobile;

    db.query(sql, [param, password], (err, result) => {
        if (err) {
            console.log("❌ Login DB error:", err.message);
            return res.json({ success: false });
        }

        if (result.length > 0) {
            console.log("✅ Login success:", param);
            res.json({ success: true, user: result[0] });
        } else {
            console.log("❌ Login failed for:", param);
            res.json({ success: false });
        }
    });
});

// ── Send OTP ──
app.post('/api/send-otp', (req, res) => {
    const { email } = req.body;

    if (!email) return res.json({ success: false, error: "Email is required." });

    const normalizedEmail = email.toLowerCase().trim();
    console.log("🔍 Looking for email in DB:", normalizedEmail);

    db.query("SELECT * FROM user WHERE email = ?", [normalizedEmail], (err, result) => {
        if (err) {
            console.log("❌ DB Error during OTP check:", err.message);
            return res.json({ success: false });
        }

        console.log("🔍 DB result rows:", result.length);

        if (result.length === 0) {
            console.log("❌ Email not found in DB:", normalizedEmail);
            return res.json({ success: false, reason: "not_registered" });
        }

        // ✅ Generate OTP
        const otp     = generateOTP();
        const expires = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes from now

        // ✅ Save OTP in memory
        otpStore[normalizedEmail] = { otp, expires: expires.getTime() };

        console.log("📧 Sending OTP to:", normalizedEmail, "| OTP:", otp);

        const mailOptions = {
            from:    `"FuelX" <${process.env.EMAIL_USER}>`,
            to:      normalizedEmail,
            subject: '🔐 FuelX OTP Verification',
            html: `
                <div style="font-family:Poppins,sans-serif;max-width:400px;margin:auto;padding:20px;border-radius:10px;background:#111;color:#fff;text-align:center;">
                    <h2 style="color:#facc15;">FuelX Password Reset</h2>
                    <p>Use the OTP below to reset your password.</p>
                    <h1 style="color:#f97316;letter-spacing:8px;">${otp}</h1>
                    <p style="color:#aaa;font-size:12px;">Valid for 5 minutes. Do not share this OTP.</p>
                </div>
            `
        };

       transporter.sendMail(mailOptions, (mailErr, info) => {
    if (mailErr) {
        console.log("❌ Email send error FULL:", mailErr);
        return res.json({ success: false, error: "Failed to send email." });
    }
    console.log("✅ Email sent:", info.response);
    res.json({ success: true });
});
    });
});

// ── Verify OTP ──
app.post('/api/verify-otp', (req, res) => {
    const { email, otp } = req.body;

    if (!email || !otp) return res.json({ success: false, error: "Email and OTP required." });

    const normalizedEmail = email.toLowerCase().trim();
    const record          = otpStore[normalizedEmail];

    if (!record) {
        console.log("❌ No OTP found for:", normalizedEmail);
        return res.json({ success: false, reason: "no_otp" });
    }

    if (Date.now() > record.expires) {
        delete otpStore[normalizedEmail];
        console.log("❌ OTP expired for:", normalizedEmail);
        return res.json({ success: false, reason: "expired" });
    }

    if (record.otp !== otp.trim()) {
        console.log("❌ Wrong OTP for:", normalizedEmail);
        return res.json({ success: false, reason: "wrong_otp" });
    }

    // ✅ OTP is correct
    delete otpStore[normalizedEmail];
    console.log("✅ OTP verified for:", normalizedEmail);
    res.json({ success: true });
});

// ── Reset Password ──
app.post('/api/reset-password', (req, res) => {
    const { email, newPassword } = req.body;

    if (!email || !newPassword) {
        return res.json({ success: false, error: "Email and new password required." });
    }

    if (newPassword.length < 6) {
        return res.json({ success: false, error: "Password must be at least 6 characters." });
    }

    const normalizedEmail = email.toLowerCase().trim();

    db.query(
        "UPDATE user SET password = ? WHERE email = ?",
        [newPassword, normalizedEmail],
        (err, result) => {
            if (err) {
                console.log("❌ Reset password DB error:", err.message);
                return res.json({ success: false });
            }
            if (result.affectedRows === 0) {
                console.log("❌ No user found to update password:", normalizedEmail);
                return res.json({ success: false, error: "User not found." });
            }
            console.log("✅ Password reset for:", normalizedEmail);
            res.json({ success: true });
        }
    );
});
// ================= PLACE ORDER =================
app.post('/api/place-order', (req, res) => {
    const {
        vehicle_number,
        fuel_type,
        quantity,
        location,
        pump_name,
        payment_method,
        txn_id
    } = req.body;

    if (!vehicle_number || !fuel_type || !quantity || !location || !pump_name) {
        return res.json({ success: false, error: "All fields required" });
    }

    db.query(
        `INSERT INTO fuel_requests 
        (vehicle_number, fuel_type, quantity, location, pump_name, payment_method, txn_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending')`,
        [vehicle_number, fuel_type, quantity, location, pump_name, payment_method, txn_id],
        (err, result) => {
            if (err) {
                console.log("❌ Order insert error:", err.message);
                return res.json({ success: false });
            }

            console.log("✅ New order placed:", result.insertId);
            res.json({ success: true, orderId: result.insertId });
        }
    );
});
// ================= ADMIN ORDER ROUTES =================

// 📦 Get all orders (already used by dashboard)
app.get('/api/fuel-requests', (req, res) => {
    db.query("SELECT * FROM fuel_requests ORDER BY created_at DESC", (err, result) => {
        if (err) {
            console.log("❌ Fetch orders error:", err.message);
            return res.json({ success: false });
        }
        res.json({ success: true, data: result });
    });
});


// ✅ ACCEPT ORDER (Admin)
app.put('/api/orders/:id/accept', (req, res) => {
    const id = req.params.id;

    db.query(
        "UPDATE fuel_requests SET status = 'Ongoing' WHERE id = ?",
        [id],
        (err) => {
            if (err) {
                console.log("❌ Accept order error:", err.message);
                return res.json({ success: false });
            }
            console.log("✅ Order accepted:", id);
            res.json({ success: true });
        }
    );
});


// 🚚 MARK AS DELIVERED
app.put('/api/orders/:id/deliver', (req, res) => {
    const id = req.params.id;

    db.query(
        "UPDATE fuel_requests SET status = 'Delivered' WHERE id = ?",
        [id],
        (err) => {
            if (err) {
                console.log("❌ Deliver order error:", err.message);
                return res.json({ success: false });
            }
            console.log("✅ Order delivered:", id);
            res.json({ success: true });
        }
    );
});


// ❌ CANCEL ORDER
app.put('/api/orders/:id/cancel', (req, res) => {
    const id = req.params.id;
    const { reason } = req.body;

    db.query(
        "UPDATE fuel_requests SET status = 'Cancelled', cancel_reason=?, cancelled_at=NOW() WHERE id = ?",
        [reason || 'Cancelled by admin', id],
        (err) => {
            if (err) {
                console.log("❌ Cancel order error:", err.message);
                return res.json({ success: false });
            }
            console.log("❌ Order cancelled:", id);
            res.json({ success: true });
        }
    );
});
// ================= SERVER =================
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);

    import('open').then(open => {
        open.default(`http://localhost:${PORT}`);
    });
});