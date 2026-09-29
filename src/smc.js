export function analyzeSMC(candles) {
  if (!Array.isArray(candles) || candles.length !== 12) throw new Error("Exactly 12 closed M5 candles required");
  const c=candles.map(x=>({...x,open:+x.open,high:+x.high,low:+x.low,close:+x.close}));
  const ranges=c.map(x=>x.high-x.low), avg=ranges.reduce((a,b)=>a+b,0)/12;
  const last=c[11], prev=c.slice(0,11);
  const prevHigh=Math.max(...prev.map(x=>x.high)), prevLow=Math.min(...prev.map(x=>x.low));
  const bullDisp=last.close>last.open && (last.high-last.low)>avg*1.5;
  const bearDisp=last.close<last.open && (last.high-last.low)>avg*1.5;
  const sweepLow=prev.some((x,i)=>i>0 && x.low<Math.min(...c.slice(0,i).map(y=>y.low)) && x.close>x.low);
  const sweepHigh=prev.some((x,i)=>i>0 && x.high>Math.max(...c.slice(0,i).map(y=>y.high)) && x.close<x.high);
  const bosUp=last.close>prevHigh, bosDown=last.close<prevLow;
  let bullFvg=false,bearFvg=false;
  for(let i=2;i<c.length;i++){ if(c[i].low>c[i-2].high) bullFvg=true; if(c[i].high<c[i-2].low) bearFvg=true; }
  const bullPoints=(bosUp?25:0)+(sweepLow?25:0)+(bullDisp?20:0)+(bullFvg?20:0)+(last.close>c[0].open?10:0);
  const bearPoints=(bosDown?25:0)+(sweepHigh?25:0)+(bearDisp?20:0)+(bearFvg?20:0)+(last.close<c[0].open?10:0);
  return {bullishScore:bullPoints,bearishScore:bearPoints,features:{bosUp,bosDown,sweepLow,sweepHigh,bullDisp,bearDisp,bullFvg,bearFvg},range:{high:Math.max(...c.map(x=>x.high)),low:Math.min(...c.map(x=>x.low))}};
}