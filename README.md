# BOSS HUNTER 3D (เว็บเกมออนไลน์)

ไฟล์ในโฟลเดอร์นี้คือเว็บทั้งเว็บ: `server.js` (เสิร์ฟหน้าเกมและเป็นตัวกลางห้องออนไลน์ผ่าน WebSocket ไม่ต้องติดตั้งแพ็กเกจเพิ่ม) กับ `public/index.html` (ตัวเกม)

## ลองในเครื่อง
    node server.js
    เปิด http://localhost:3000

## ทำให้เข้าเล่นได้ตลอดเวลา
ต้องนำไปรันบนเซิร์ฟเวอร์ที่เปิดตลอด 24 ชั่วโมงและรองรับ WebSocket เลือกอย่างใดอย่างหนึ่ง

**Render** (ง่ายสุด): ผลักโฟลเดอร์นี้ขึ้น GitHub > Render > New > Blueprint (ใช้ `render.yaml`) หรือ New Web Service ตั้ง Start Command เป็น `node server.js` แผนฟรีจะหลับเมื่อไม่มีคนเข้า ถ้าต้องการให้ตื่นตลอดให้ใช้แผนที่เสียเงินขั้นต่ำ

**Fly.io / Railway / Koyeb**: มี `Dockerfile` ให้แล้ว (`fly launch` หรือเชื่อม GitHub repo) ตัวแปร `PORT` อ่านจาก environment อัตโนมัติ

**VPS ของตัวเอง**: `npm i -g pm2 && pm2 start server.js --name bosshunter && pm2 save` แล้วตั้ง nginx/Caddy เป็น HTTPS และเปิด WebSocket (`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`)

ต้องใช้ HTTPS เพื่อให้เสียงและการล็อกเมาส์ทำงานครบ และให้ส่งต่อ header `Host` ตามจริง เพราะเซิร์ฟเวอร์ตรวจ Origin ให้ตรงกับโดเมนของเว็บ (ถ้าจำเป็นต้องข้ามโดเมน ตั้ง `ALLOW_ANY_ORIGIN=1`)

## ตรวจสถานะ
`/healthz` แสดงจำนวนการเชื่อมต่อและห้องที่เปิดอยู่

## ล็อคอินด้วย Google + เซฟบนเซิร์ฟเวอร์ (ไม่บังคับ)
1. Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → ชนิด **Web application**
2. ใส่ **Authorized JavaScript origins** = URL เว็บ Render ของคุณ (เช่น `https://ชื่อแอป.onrender.com`)
3. คัดลอก Client ID (ลงท้าย `.apps.googleusercontent.com`) ไปใส่ใน Render → Environment → `GOOGLE_CLIENT_ID`
4. (แนะนำ) ตั้ง `SESSION_SECRET` เป็นข้อความสุ่มยาวๆ และ `DATA_DIR` ชี้ไปที่ Render Disk (เช่น `/data`) ไม่งั้นเซฟจะหายเมื่อ Render รีสตาร์ท/ดีพลอยใหม่ (แพ็กเกจฟรีไม่มีดิสก์ถาวร)
ถ้าไม่ตั้ง `GOOGLE_CLIENT_ID` ปุ่มล็อคอินจะไม่แสดงและเกมทำงานเหมือนเดิม

## ระบบบัญชีผู้เล่น (Login / Register / Profile)

### โครงสร้างไฟล์
```
server.js        เซิร์ฟเวอร์หลัก (static + WebSocket ห้องออนไลน์ + API)
accounts.js      ระบบบัญชี: SQLite + scrypt + session (ฝั่ง Backend)
public/index.html  เกม + หน้า Login/Register/Profile (ฝั่ง Frontend, สร้างจาก build)
test.js          ทดสอบเซิร์ฟเวอร์พื้นฐาน     test_accounts.js  ทดสอบ API บัญชี
Dockerfile, render.yaml, package.json
```
ต้องใช้ **Node 22.13+** (ใช้ `node:sqlite` ในตัว ไม่ต้องติดตั้งแพ็กเกจ). ไฟล์ฐานข้อมูล: `$DATA_DIR/bosshunter.db`

### Database Schema
```sql
users(id PK, player_id UNIQUE, username UNIQUE NOCASE, email UNIQUE NOCASE, pass_salt, pass_hash, created_at)
player_data(user_id PK -> users.id, level, exp, money, wins, losses, play_seconds, last_ping, last_win, save_json, updated_at)
sessions(token_hash PK, user_id -> users.id, expires_at, created_at)
```
### API
| Method | Path | หน้าที่ |
|---|---|---|
| POST | /api/auth/register | {username,email,password,confirm,remember} |
| POST | /api/auth/login | {id (username หรือ email),password,remember} |
| POST | /api/auth/logout | ลบ session ฝั่งเซิร์ฟเวอร์ |
| GET | /api/auth/profile | ข้อมูลโปรไฟล์ (Bearer token) |
| GET/PUT | /api/save | โหลด/บันทึกเซฟของบัญชีตัวเอง |
| POST | /api/event | {type:win/loss} เซิร์ฟเวอร์นับชนะ/แพ้เอง (กันยิงถี่) |
| POST | /api/ping | เซิร์ฟเวอร์นับเวลาเล่นด้วยนาฬิกาตัวเอง |

### ความปลอดภัย
- รหัสผ่านเข้ารหัสด้วย **scrypt** (salt สุ่มต่อบัญชี, N=16384) — ไม่ได้ใช้ Argon2id/bcrypt เพราะ Node ไม่มีในตัวและโปรเจกต์นี้ไม่มี dependency
- Session แบบสุ่ม 256 บิต เก็บเฉพาะแฮชใน DB (หมดอายุ 1 วัน / 30 วันถ้าติ๊กจดจำ) ออกจากระบบ = ลบ session จริง
- Prepared statements ทุกคำสั่ง (กัน SQL Injection), ตรวจสิทธิ์จาก session ทุกครั้ง, ผู้เล่นเข้าถึงได้เฉพาะแถวของตัวเอง
- กันเดารหัส: ผิด 5 ครั้งล็อค 10 นาที (ต่อ IP และต่อบัญชี), จำกัดการสมัครต่อ IP
- Level/EXP/เงิน ถูกคำนวณจากเซฟบนเซิร์ฟเวอร์, ชนะ/แพ้/เวลาเล่น เซิร์ฟเวอร์นับเอง (ไคลเอนต์ส่งตัวเลขเหล่านี้ตรง ๆ ไม่ได้)
- **ข้อจำกัด:** เกมคำนวณการต่อสู้ฝั่งเบราว์เซอร์ จึงกันการโกงเซฟ (เช่นแก้เงินในเซฟ) ได้ไม่สมบูรณ์

### ติดตั้ง / ทดสอบ
1. `node server.js` (หรือ deploy บน Render; ตั้ง `DATA_DIR` ไปที่ Persistent Disk เพื่อให้บัญชีไม่หาย)
2. เปิดเว็บ → หน้าล็อคอินขึ้นอัตโนมัติ → REGISTER → กรอกชื่อ/อีเมล/รหัสผ่าน (8+ ตัว มีตัวอักษรและตัวเลข) → เข้าเกม
3. ปุ่ม "โปรไฟล์" ในเมนูหลักดูข้อมูลผู้เล่น, "ออกจากระบบ" เพื่อออก
4. ทดสอบ API: `PORT=8127 DATA_DIR=/tmp/bh node server.js &` แล้ว `node test_accounts.js`
5. ถ้าไม่มีเซิร์ฟเวอร์ (เปิดเป็นไฟล์/พรีวิว) เกมจะใช้บัญชีที่เก็บในเบราว์เซอร์แทนอัตโนมัติ
