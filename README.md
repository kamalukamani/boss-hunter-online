# BOSS HUNTER ONLINE

เว็บเกม Boss Hunter Online พร้อมระบบห้อง Multiplayer และระบบบัญชีผู้เล่นที่จัดเก็บบน MongoDB Atlas

## สิ่งที่ใช้
- Node.js 22.13+
- MongoDB Atlas
- MongoDB Node.js Driver (`mongodb`)
- WebSocket room relay ในตัวเซิร์ฟเวอร์ (ไม่ต้องติดตั้งแพ็กเกจ WebSocket เพิ่ม)

## ตั้งค่า MongoDB Atlas
1. สร้าง Database User ใน MongoDB Atlas
2. ตั้งค่า Network Access ให้เซิร์ฟเวอร์ที่ใช้งานเชื่อมต่อได้ (สำหรับทดสอบอาจใช้ IP ที่อนุญาตแบบจำกัดตามความเหมาะสม)
3. คัดลอก Connection String จาก Atlas
4. ตั้งค่าตัวแปร `MONGODB_URI` เป็น Connection String โดยแทน username/password ด้วยค่าจริง
5. ตั้ง `MONGODB_DB_NAME=BossHunterOnline`

**อย่าอัปโหลด `.env` หรือส่ง Connection String ที่มีรหัสผ่านให้ผู้อื่น และห้าม commit ลง GitHub**

### รันในเครื่อง
```bash
npm install
```
สร้างไฟล์ `.env` จาก `.env.example` แล้วใส่ Connection String จริง จากนั้นรัน:
```bash
node --env-file=.env server.js
```
เปิด `http://localhost:3000`

ถ้าใช้ Windows PowerShell และไม่ต้องการใช้ `--env-file` สามารถตั้ง environment variable ในระบบก่อนรันเซิร์ฟเวอร์ได้

## Deploy บน Render
1. อัปโหลดโปรเจกต์นี้ขึ้น GitHub โดยตรวจสอบว่า `.env` ไม่ได้อยู่ใน repository
2. สร้าง Render Web Service หรือใช้ Blueprint จาก `render.yaml`
3. ใน Render > Environment ตั้ง `MONGODB_URI` เป็น Connection String จริง
4. ตรวจสอบ `MONGODB_DB_NAME` เป็น `BossHunterOnline`
5. Deploy แล้วเปิด `/healthz` ตรวจสอบสถานะ

Render จะติดตั้ง dependency ด้วย `npm install` ตาม `buildCommand` ใน Blueprint

## ฐานข้อมูล
ระบบสร้าง collections และ indexes ให้อัตโนมัติเมื่อเชื่อมต่อสำเร็จ:
- `users` — ชื่อผู้ใช้ อีเมล และ password hash
- `player_data` — Level, EXP, เงิน, ชนะ/แพ้, เวลาเล่น, `total_damage`, `kills`, `total_recv`, `deaths`, `revives` และข้อมูลเซฟ (มี index สำหรับ Leaderboard: level+exp, total_damage, money)
- `sessions` — เก็บ hash ของ session token พร้อมวันหมดอายุ

ชื่อฐานข้อมูลเริ่มต้นคือ `BossHunterOnline` และเปลี่ยนได้ด้วย `MONGODB_DB_NAME`

## API บัญชี
| Method | Path | หน้าที่ |
|---|---|---|
| POST | `/api/auth/register` | สมัครสมาชิก |
| POST | `/api/auth/login` | เข้าสู่ระบบด้วยชื่อผู้ใช้หรืออีเมล |
| POST | `/api/auth/logout` | ออกจากระบบและเพิกถอน session |
| GET | `/api/auth/profile` | ดูโปรไฟล์ |
| GET/PUT | `/api/save` | โหลด/บันทึกเซฟของบัญชี |
| POST | `/api/event` | บันทึกชนะ/แพ้ |
| POST | `/api/ping` | บันทึกเวลาเล่น |
| POST | `/api/stats` | สถิติโหมดเล่นคนเดียว (Damage/Kills ถูกจำกัดอัตราฝั่งเซิร์ฟเวอร์) |
| GET | `/api/leaderboard?type=level\|damage\|money` | อันดับ 1–100 + อันดับของตัวเอง |
| GET | `/api/online` | รายชื่อผู้เล่นออนไลน์ |
| GET | `/api/config` | ตรวจสอบความพร้อมของระบบบัญชี |

## Scoreboard / ผู้เล่นออนไลน์ / Leaderboard / Revive
- กดปุ่ม Scoreboard ระหว่างเล่น (หรือปุ่มอันดับ 🏆 ที่เมนูหลัก) เพื่อดูตารางผู้เล่นในห้อง: ชื่อ, Level, เงิน, Kills, Damage Dealt/Received, Deaths, Revives, จำนวนผู้เล่นออนไลน์ทั้งเซิร์ฟเวอร์/ในห้อง
- ชื่อในเกมมาจากบัญชีที่ล็อกอิน (เซิร์ฟเวอร์กำหนด ไคลเอนต์เปลี่ยนไม่ได้) และมี Player ID ไม่ซ้ำ
- Leaderboard 3 หมวด (Level+EXP, Damage สะสม, เงิน) อันดับ 1–100 เก็บถาวรใน MongoDB
- เมื่อ HP หมด ผู้เล่นจะ Downed ไม่เกิดใหม่เอง เพื่อนเข้าใกล้แล้วกด **E ค้าง 5 วินาที** เพื่อชุบ → ฟื้น 30% HP และอมตะ 2 วินาที (เซิร์ฟเวอร์ตรวจเวลา/ระยะ/ป้องกันชุบซ้ำ)
- เซิร์ฟเวอร์จำกัดอัตรา Damage/Kills/Deaths ที่ไคลเอนต์รายงาน แต่เกมคำนวณการต่อสู้ในเบราว์เซอร์ จึงเป็นการตรวจความสมเหตุสมผล ไม่ใช่การจำลองซ้ำทั้งหมด

## ความปลอดภัยและข้อควรทราบ
- รหัสผ่านถูกแฮชด้วย `scrypt` พร้อม salt สุ่มต่อบัญชี
- Session token สุ่ม 256 บิต; ฐานข้อมูลเก็บเฉพาะ SHA-256 hash
- ใช้ MongoDB unique indexes ป้องกันชื่อผู้ใช้ อีเมล และ Player ID ซ้ำ
- คำขอ API ตรวจสอบ session และจำกัดอัตราการเรียกบาง endpoint
- เซิร์ฟเวอร์ตรวจสอบขนาดและรูปแบบข้อมูลเซฟก่อนบันทึก
- เกมยังคำนวณการต่อสู้ฝั่งเบราว์เซอร์ จึงไม่สามารถป้องกันการโกงทุกชนิดได้
- ระบบบัญชี MongoDB จะปิดและเกมกลับไปใช้บัญชีในเบราว์เซอร์ หากไม่ได้ตั้ง `MONGODB_URI` หรือเชื่อมต่อฐานข้อมูลไม่สำเร็จ
- Google Login แบบเดิมยังคงใช้ได้แยกจากระบบบัญชี MongoDB

## ทดสอบ Multiplayer 2–4 คน
```bash
npm run test:relay      # ห้อง/presence/จำกัด 16 คน
npm run test:multi      # 4 ผู้เล่น: Scoreboard, Downed/Revive, Leaderboard (ต้องรันเซิร์ฟเวอร์ที่ PORT เดียวกัน)
```
หรือเปิดเกมสองแท็บ/สองเครื่อง ล็อกอินคนละบัญชี เข้าห้องเดียวกัน แล้วทดสอบตาย–ชุบ

## ทดสอบ API บัญชี
ตั้ง `MONGODB_URI` ให้ชี้ไปยังฐานข้อมูลทดสอบก่อน จากนั้นเปิดเซิร์ฟเวอร์และรัน:
```bash
npm run test:accounts
```
การทดสอบจะสร้างบัญชีทดสอบในฐานข้อมูลที่กำหนด ควรใช้ฐานข้อมูลทดสอบแยกจากข้อมูลผู้เล่นจริง
