# BOSS HUNTER 3D — เว็บเกมออนไลน์

โปรเจกต์นี้มีทั้งหน้าเกมและเซิร์ฟเวอร์ห้องออนไลน์อยู่ใน ZIP เดียวกัน

- `public/index.html` — หน้าเกม
- `server.js` — เว็บเซิร์ฟเวอร์และ WebSocket สำหรับห้องออนไลน์
- `render.yaml` — ตั้งค่า Deploy บน Render Free

## ทดสอบในเครื่อง

ต้องติดตั้ง Node.js 18 ขึ้นไป จากนั้นเปิด Terminal ในโฟลเดอร์นี้แล้วรัน:

```bash
node server.js
```

เปิด `http://localhost:3000` ในเบราว์เซอร์

## Deploy ฟรีบน Render (แนะนำ)

**อย่าอัปโหลดเฉพาะ `public/` ไป Netlify Drop** เพราะระบบห้องออนไลน์ต้องใช้ `server.js` และ WebSocket

1. แตกไฟล์ ZIP นี้ลงในโฟลเดอร์
2. สร้าง Repository ใหม่บน GitHub แล้วอัปโหลดไฟล์และโฟลเดอร์ทั้งหมด โดยให้ `server.js`, `package.json`, `render.yaml` และ `public/` อยู่ที่ระดับบนสุด
3. เข้า https://dashboard.render.com/ แล้วเชื่อมบัญชี GitHub
4. เลือก **New > Blueprint**
5. เลือก Repository ที่อัปโหลดไว้ แล้วทำตามขั้นตอนสร้างบริการจาก `render.yaml`
6. ตรวจสอบว่า Instance Plan เป็น **Free** แล้ว Deploy
7. เมื่อ Deploy สำเร็จ เปิด URL ที่ลงท้ายด้วย `.onrender.com`

Render Free จะพักบริการหลังไม่มีทราฟฟิกประมาณ 15 นาที และอาจใช้เวลาประมาณหนึ่งนาทีในการตื่นเมื่อมีคนเข้าใหม่ การเชื่อมต่อห้องอาจหลุดเมื่อบริการรีสตาร์ตหรือ Deploy ใหม่

## ตรวจสอบเซิร์ฟเวอร์

เปิด `https://ชื่อบริการ.onrender.com/healthz` ควรเห็น JSON ที่มี `"ok":true`

## หมายเหตุ

- ผู้เล่นทุกคนต้องเข้าเกมจาก URL ของ Render เดียวกัน
- เกมนี้ใช้ WebSocket ที่ path `/ws`
- ห้องรองรับผู้เล่นสูงสุด 8 คนตามค่าที่กำหนดใน `server.js`
- Free tier มีข้อจำกัดด้านชั่วโมงใช้งาน แบนด์วิดท์ และการพักบริการ ดูรายละเอียดได้ที่ https://render.com/docs/free
