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
