// Isolated UI preview: no real configuration, credentials, service or messages.
import http from 'node:http';
import fs from 'node:fs/promises';
import { notificationRules, notificationEnabled, resetReminderLeads, validateNotificationSettings } from '../../notification-settings.mjs';
let config={};
const html=await fs.readFile(new URL('../../dashboard.html',import.meta.url));
const server=http.createServer(async(req,res)=>{
  if(req.url==='/'){res.writeHead(200,{'content-type':'text/html;charset=utf-8'});return res.end(html)}
  let value={};
  if(req.url==='/api/notifications/settings'){
    if(req.method==='POST'){
      let raw='';for await(const chunk of req)raw+=chunk;
      try{const update=validateNotificationSettings(JSON.parse(raw));config={...config,...update,notificationTypes:{...config.notificationTypes,...update.notificationTypes}};value={ok:true}}
      catch(error){res.statusCode=400;value={error:error.message}}
    }else value={rules:notificationRules.map(rule=>({...rule,enabled:notificationEnabled(config,rule.id)})),resetReminderLeadMinutes:resetReminderLeads(config),stallMinutes:config.stallMinutes||3};
  }else if(req.url==='/api/status')value={version:'UI-PREVIEW',config:{},accounts:[],tasks:{},approvals:[],security:{local:true},feishu:{},network:{},nativeVault:{},taskActivity:{rows:[]}};
  else if(req.url.startsWith('/api/threads'))value={threads:[]};
  else if(req.url.startsWith('/api/notifications/apps'))value={apps:[]};
  else if(req.url.startsWith('/api/notifications/history'))value={history:[]};
  res.setHeader('content-type','application/json');res.end(JSON.stringify(value));
});
server.listen(17842,'127.0.0.1',()=>console.log(`Isolated dashboard preview: http://127.0.0.1:17842/ PID=${process.pid}`));
