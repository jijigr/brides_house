import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';

const root=join(process.cwd(),'dist'),storePath=join(process.cwd(),'data','bookings.json');
async function loadLocalEnv(){try{const lines=(await readFile(join(process.cwd(),'.env'),'utf8')).split(/\r?\n/);for(const line of lines){const match=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(match&&process.env[match[1]]===undefined)process.env[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2')}}catch(error){if(error.code!=='ENOENT')throw error}}
await loadLocalEnv();
const adminPassword=process.env.ADMIN_PASSWORD;
const sessions=new Set();
const defaultSlotTimes=['10:00','11:20','12:40','14:00','15:20','16:40','18:00'];
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
async function data(){if(!existsSync(storePath)){await mkdir(join(process.cwd(),'data'),{recursive:true});await writeFile(storePath,JSON.stringify({bookings:[],closedDates:[]},null,2));}return JSON.parse(await readFile(storePath,'utf8'))}
async function save(value){await writeFile(storePath,JSON.stringify(value,null,2))}
function isHoliday(date,closed=[]){const [,m,d]=date.split('-').map(Number);return closed.includes(date)||([[1,1],[1,2],[1,3],[1,4],[1,5],[1,6],[1,7],[1,8],[2,23],[3,8],[5,1],[5,9],[6,12],[11,4]].some(([mm,dd])=>m===mm&&d===dd))}
function timesFor(store,date){return Object.hasOwn(store.dateSchedules||{},date)?store.dateSchedules[date]:(store.slotTimes||defaultSlotTimes)}
function json(res,status,payload){res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(payload))}
function auth(req){return sessions.has((req.headers.authorization||'').replace('Bearer ',''))}
function readBody(req){return new Promise((resolve,reject)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{try{resolve(JSON.parse(raw||'{}'))}catch{reject(new Error('bad json'))}})})}
function safe(value=''){return String(value).trim().slice(0,160)}
function validDate(value){return /^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T12:00:00'))}
function validTimes(value){return Array.isArray(value)&&value.length<=40&&value.every(t=>/^([01]\d|2[0-3]):[0-5]\d$/.test(t))&&new Set(value).size===value.length}
async function createBooking(body,res){const d=await data(),date=safe(body.date),time=safe(body.time),name=safe(body.name),phone=safe(body.phone);if(!date||!validDate(date)||!timesFor(d,date).includes(time)||name.length<2||phone.length<6)return json(res,400,{error:'Заполните имя, телефон, дату и доступное время.'});if(isHoliday(date,d.closedDates))return json(res,409,{error:'Этот день недоступен.'});if(d.bookings.some(b=>b.date===date&&b.time===time&&b.status==='confirmed'))return json(res,409,{error:'Это время уже занято. Выберите другое.'});const booking={id:randomUUID(),date,time,name,phone,dresses:Array.isArray(body.dresses)?body.dresses.map(safe).filter(Boolean).slice(0,12):[],note:safe(body.note),createdAt:new Date().toISOString(),status:'confirmed'};d.bookings.push(booking);await save(d);json(res,201,{booking})}

const server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&url.pathname==='/api/slots'){const d=await data(),date=url.searchParams.get('date');if(!date||!validDate(date))return json(res,400,{error:'Укажите корректную дату'});return json(res,200,{holiday:isHoliday(date,d.closedDates),slots:timesFor(d,date).map(time=>({time,taken:d.bookings.some(b=>b.date===date&&b.time===time&&b.status==='confirmed')}))})}
  if(req.method==='POST'&&url.pathname==='/api/book')return createBooking(await readBody(req),res);
  if(req.method==='POST'&&url.pathname==='/api/admin/login'){const {password}=await readBody(req);if(!adminPassword)return json(res,503,{error:'Администратор не настроен: задайте ADMIN_PASSWORD в переменных окружения.'});if(password!==adminPassword)return json(res,401,{error:'Неверный пароль'});const token=randomUUID();sessions.add(token);return json(res,200,{token})}
  if(url.pathname.startsWith('/api/admin/')){
    if(!auth(req))return json(res,401,{error:'Требуется вход администратора'});
    const d=await data();
    if(req.method==='GET'&&url.pathname==='/api/admin/bookings')return json(res,200,{bookings:d.bookings.sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)),closedDates:d.closedDates||[],slotTimes:d.slotTimes||defaultSlotTimes,dateSchedules:d.dateSchedules||{}});
    if(req.method==='POST'&&url.pathname==='/api/admin/book')return createBooking(await readBody(req),res);
    if(req.method==='PUT'&&url.pathname==='/api/admin/schedule'){
      const body=await readBody(req),date=safe(body.date),slotTimes=body.slotTimes;
      if(!validDate(date)||!validTimes(slotTimes)||typeof body.closed!=='boolean')return json(res,400,{error:'Проверьте дату и список времени.'});
      const booked=d.bookings.filter(b=>b.date===date&&b.status==='confirmed');
      if(body.closed&&booked.length)return json(res,409,{error:'На этот день уже есть записи. Сначала отмените их или перенесите на другую дату.'});
      const missing=booked.filter(b=>!slotTimes.includes(b.time));
      if(missing.length)return json(res,409,{error:'Нельзя убрать время, на которое уже записана клиентка. Сначала перенесите или отмените запись.'});
      d.dateSchedules=d.dateSchedules||{};d.dateSchedules[date]=slotTimes;
      d.closedDates=d.closedDates||[];
      d.closedDates=body.closed?[...new Set([...d.closedDates,date])]:d.closedDates.filter(x=>x!==date);
      await save(d);return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&url.pathname==='/api/admin/close-date'){const {date}=await readBody(req);if(!validDate(date))return json(res,400,{error:'Неверная дата'});d.closedDates=d.closedDates||[];if(!d.closedDates.includes(date))d.closedDates.push(date);await save(d);return json(res,200,{ok:true})}
    if(req.method==='DELETE'&&url.pathname.startsWith('/api/admin/bookings/')){d.bookings=d.bookings.filter(b=>b.id!==url.pathname.split('/').pop());await save(d);return json(res,200,{ok:true})}
  }
  const path=normalize(url.pathname==='/'?'/index.html':url.pathname).replace(/^([/\\])+/,''),file=join(root,path);
  if(!file.startsWith(root)||!existsSync(file)){res.writeHead(404);return res.end('Not found')}
  res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream'});res.end(await readFile(file));
}catch(error){json(res,500,{error:'Не удалось обработать запрос'})}});
server.listen(4173,()=>console.log('КовиКружево: http://127.0.0.1:4173'));
