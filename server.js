require('dotenv').config();
const express=require('express'),Database=require('better-sqlite3'),bcrypt=require('bcryptjs'),
jwt=require('jsonwebtoken'),multer=require('multer'),pdf=require('pdf-parse');
const {JWT_SECRET,ANTHROPIC_API_KEY,MODEL='claude-sonnet-4-6',PORT=3000}=process.env;
if(!JWT_SECRET||!ANTHROPIC_API_KEY){console.error('Set JWT_SECRET and ANTHROPIC_API_KEY in .env');process.exit(1)}
const db=new Database('study.db'),app=express(),up=multer({storage:multer.memoryStorage(),limits:{fileSize:5e6}});
db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT,email TEXT UNIQUE,hash TEXT);
CREATE TABLE IF NOT EXISTS conversations(id INTEGER PRIMARY KEY,user_id INT,title TEXT,doc_name TEXT,doc_text TEXT,created DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,conv_id INT REFERENCES conversations(id) ON DELETE CASCADE,role TEXT,content TEXT,mode TEXT,created DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS saved(id INTEGER PRIMARY KEY,user_id INT,conv_id INT,kind TEXT,title TEXT,content TEXT,level TEXT,created DEFAULT CURRENT_TIMESTAMP);`);
app.use(express.json({limit:'1mb'}));app.use(express.static('public'));

const sign=u=>jwt.sign({id:u.id},JWT_SECRET,{expiresIn:'7d'});
const auth=(req,res,next)=>{try{req.uid=jwt.verify((req.headers.authorization||'').replace('Bearer ',''),JWT_SECRET).id;next()}catch{res.status(401).json({error:'Please log in again.'})}};
const wrap=f=>(req,res)=>Promise.resolve(f(req,res)).catch(e=>{console.error(e);res.status(500).json({error:e.message||'Server error'})});

app.post('/api/register',wrap(async(req,res)=>{
  const {name,email,password}=req.body;
  if(!name||!/^\S+@\S+\.\S+$/.test(email||'')||(password||'').length<6)return res.status(400).json({error:'Enter a name, valid email and a password of 6+ characters.'});
  try{const r=db.prepare('INSERT INTO users(name,email,hash) VALUES(?,?,?)').run(name,email.toLowerCase(),await bcrypt.hash(password,10));
    res.json({token:sign({id:r.lastInsertRowid}),name})}catch{res.status(409).json({error:'That email is already registered.'})}}));
app.post('/api/login',wrap(async(req,res)=>{
  const u=db.prepare('SELECT * FROM users WHERE email=?').get((req.body.email||'').toLowerCase());
  if(!u||!(await bcrypt.compare(req.body.password||'',u.hash)))return res.status(401).json({error:'Wrong email or password.'});
  res.json({token:sign(u),name:u.name})}));

const own=(req,id)=>db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(id,req.uid);
app.get('/api/conversations',auth,(req,res)=>res.json(db.prepare('SELECT id,title,doc_name FROM conversations WHERE user_id=? ORDER BY id DESC').all(req.uid)));
app.post('/api/conversations',auth,(req,res)=>res.json({id:db.prepare('INSERT INTO conversations(user_id,title) VALUES(?,?)').run(req.uid,'New study session').lastInsertRowid}));
app.delete('/api/conversations/:id',auth,(req,res)=>{if(own(req,req.params.id))db.prepare('DELETE FROM conversations WHERE id=?').run(req.params.id);res.json({ok:1})});
app.get('/api/conversations/:id/messages',auth,(req,res)=>own(req,req.params.id)?res.json(db.prepare('SELECT role,content,mode FROM messages WHERE conv_id=? ORDER BY id').all(req.params.id)):res.status(404).json({error:'Not found'}));
app.get('/api/saved',auth,(req,res)=>res.json(db.prepare('SELECT id,kind,title,content,level,created FROM saved WHERE user_id=? ORDER BY id DESC').all(req.uid)));

app.post('/api/conversations/:id/upload',auth,up.single('file'),wrap(async(req,res)=>{
  const c=own(req,req.params.id);if(!c||!req.file)return res.status(400).json({error:'No file.'});
  const f=req.file,isPdf=f.mimetype==='application/pdf'||f.originalname.endsWith('.pdf');
  const text=isPdf?(await pdf(f.buffer)).text:f.buffer.toString('utf8');
  if(!text.trim())return res.status(400).json({error:'Could not read any text from that file.'});
  db.prepare('UPDATE conversations SET doc_name=?,doc_text=? WHERE id=?').run(f.originalname,text.slice(0,30000),c.id);
  res.json({name:f.originalname})}));

// ---- Prompt engineering ----
const LEVELS={Beginner:'Assume no prior knowledge. Use plain words, everyday analogies, and define every term.',
Intermediate:'Assume the basics are known. Add depth, connections between ideas, and typical exam-style nuance.',
Advanced:'Assume strong fundamentals. Be rigorous, cover edge cases, trade-offs and deeper theory.'};
const MODES={
explain:'Explain the topic clearly: a 2-line big-picture summary, then step-by-step explanation with one concrete example, then "Common mistakes". End with one check-your-understanding question.',
notes:'Produce concise revision notes in Markdown: "## Key ideas" (bullets), "## Definitions", "## Formulas/Rules" (if relevant), "## Remember this" (3 memory hooks). Max ~250 words.',
quiz:'Create 5 multiple-choice questions (A-D). After each question put the answer and a one-line reason inside double bars like ||Answer: B - because ...|| so the app can hide it. Vary difficulty within the level.',
plan:'Create a personalised study plan as a day-by-day Markdown checklist ("- [ ]"). If the student gave no timeframe, assume 7 days. Include daily time, goals, practice tasks and a final review day.',
chat:'Answer the student conversationally and accurately. Keep it short unless asked for more.'};
const system=(mode,level,doc)=>`You are Sage, a warm, encouraging study tutor. Be accurate; if unsure, say so. Use Markdown.
Difficulty: ${level}. ${LEVELS[level]||LEVELS.Beginner}
Task: ${MODES[mode]||MODES.chat}${doc?`\nThe student uploaded a document. Base answers on it when relevant and say when something is not in it.\n<document>\n${doc}\n</document>`:''}`;

app.post('/api/conversations/:id/chat',auth,wrap(async(req,res)=>{
  const c=own(req,req.params.id);if(!c)return res.status(404).json({error:'Conversation not found.'});
  const {message,mode='explain',level='Beginner'}=req.body;
  if(!message||message.length>4000)return res.status(400).json({error:'Message is empty or too long.'});
  const hist=db.prepare('SELECT role,content FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT 10').all(c.id).reverse();
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',
    headers:{'x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},
    body:JSON.stringify({model:MODEL,max_tokens:1800,system:system(mode,level,c.doc_text),messages:[...hist,{role:'user',content:message}]})});
  const d=await r.json();
  if(!r.ok)return res.status(502).json({error:'The AI service had a problem: '+(d.error?.message||r.status)});
  const reply=d.content.map(b=>b.text||'').join('');
  const ins=db.prepare('INSERT INTO messages(conv_id,role,content,mode) VALUES(?,?,?,?)');
  ins.run(c.id,'user',message,mode);ins.run(c.id,'assistant',reply,mode);
  if(c.title==='New study session')db.prepare('UPDATE conversations SET title=? WHERE id=?').run(message.slice(0,40),c.id);
  if(['notes','quiz','plan'].includes(mode))db.prepare('INSERT INTO saved(user_id,conv_id,kind,title,content,level) VALUES(?,?,?,?,?,?)').run(req.uid,c.id,mode,message.slice(0,60),reply,level);
  res.json({reply})}));
app.listen(PORT,()=>console.log(`Study assistant on http://localhost:${PORT}`));
