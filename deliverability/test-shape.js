const { decide } = require('./state-machine-v2.js');
const TODAY='2026-09-28';
const day=n=>new Date(new Date(TODAY)-n*86400000).toISOString().slice(0,10);
function mk(name, fn){const readings=[];for(let n=3;n<=28;n++)readings.push({date:day(n),spamRate:fn(n),authDmarc:100,deliveryErrorRate:0});
 return {domain:name,inPlay:true,mailboxes:[{email:'a@'+name,baselineDailyLimit:40}],readings};}
const domains=[
  mk('chronic.test', ()=>1.0),                 // steady 1%
  mk('spike.test',   n=>n<=5?5.0:0.0),         // quiet, then jumps
  mk('healthy.test', ()=>0.05),                // trivially fine, every day
];
const r=decide({domains,priorStates:{},history:[],today:TODAY});
for(const x of r.results) console.log(`[${x.state}] ${x.domain}  spiking=${x.spiking}\n   ${x.reasons.join('\n   ')}`);
