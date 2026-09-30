function pivotHigh(c,i){return i>0&&i<c.length-1&&c[i].high>c[i-1].high&&c[i].high>=c[i+1].high}
function pivotLow(c,i){return i>0&&i<c.length-1&&c[i].low<c[i-1].low&&c[i].low<=c[i+1].low}
export function validateH1Block(candles){
 if(!Array.isArray(candles)||candles.length!==12)throw new Error("Exactly 12 closed M5 candles required");
 const c=candles.map(x=>({...x,time:new Date(x.time),open:+x.open,high:+x.high,low:+x.low,close:+x.close}));
 if(c.some(x=>Number.isNaN(x.time.getTime())||![x.open,x.high,x.low,x.close].every(Number.isFinite)||x.high<Math.max(x.open,x.close)||x.low>Math.min(x.open,x.close)))throw new Error("Invalid M5 OHLC/time");
 c.sort((a,b)=>a.time-b.time);const h=c[0].time.toISOString().slice(0,13);
 for(let i=0;i<12;i++){if(c[i].time.toISOString().slice(0,13)!==h||c[i].time.getUTCMinutes()!==i*5||(i&&c[i].time-c[i-1].time!==300000))throw new Error("Candles must be one contiguous H1 block: minute 00..55");}
 return c;
}
export function analyzeSMC(candles,h1Context={}){
 const c=validateH1Block(candles),ranges=c.map(x=>x.high-x.low),avg=ranges.reduce((a,b)=>a+b,0)/12;
 const ph=[],pl=[];for(let i=1;i<11;i++){if(pivotHigh(c,i))ph.push(i);if(pivotLow(c,i))pl.push(i)}
 const lastPH=ph.at(-1),lastPL=pl.at(-1);let sweepLow=false,sweepHigh=false;
 for(let i=2;i<12;i++){const lows=pl.filter(j=>j<i),highs=ph.filter(j=>j<i);if(lows.length){const l=c[lows.at(-1)].low;if(c[i].low<l&&c[i].close>l)sweepLow=true}if(highs.length){const h=c[highs.at(-1)].high;if(c[i].high>h&&c[i].close<h)sweepHigh=true}}
 const bosUp=lastPH!=null&&c.slice(lastPH+1).some(x=>x.close>c[lastPH].high),bosDown=lastPL!=null&&c.slice(lastPL+1).some(x=>x.close<c[lastPL].low);
 const bullDisp=c.some((x,i)=>i>0&&x.close>x.open&&(x.close-x.open)>avg*1.25),bearDisp=c.some((x,i)=>i>0&&x.close<x.open&&(x.open-x.close)>avg*1.25);
 const bullFvgs=[],bearFvgs=[];for(let i=2;i<12;i++){if(c[i].low>c[i-2].high)bullFvgs.push({low:c[i-2].high,high:c[i].low,index:i});if(c[i].high<c[i-2].low)bearFvgs.push({low:c[i].high,high:c[i-2].low,index:i})}
 const findOB=side=>{for(let i=10;i>=0;i--){const opp=side==="BUY"?c[i].close<c[i].open:c[i].close>c[i].open;if(opp){const z={low:c[i].low,high:c[i].high,index:i};const later=c.slice(i+1);const fresh=side==="BUY"?!later.some(x=>x.low<=z.low):!later.some(x=>x.high>=z.high);return {...z,fresh}}}return null};
 const bullOB=findOB("BUY"),bearOB=findOB("SELL"),last=c[11];
 const bullRetest=!!bullOB&&last.low<=bullOB.high&&last.high>=bullOB.low,bearRetest=!!bearOB&&last.high>=bearOB.low&&last.low<=bearOB.high;
 const h1Bull=h1Context.direction==="BUY"||h1Context.direction==="BULLISH",h1Bear=h1Context.direction==="SELL"||h1Context.direction==="BEARISH";
 const bull=(bosUp?15:0)+(sweepLow?15:0)+((bullOB?.fresh&&bullFvgs.length)?15:0)+(bullDisp?10:0)+(bullRetest?10:0)+(h1Bull?5:0);
 const bear=(bosDown?15:0)+(sweepHigh?15:0)+((bearOB?.fresh&&bearFvgs.length)?15:0)+(bearDisp?10:0)+(bearRetest?10:0)+(h1Bear?5:0);
 const normalize=x=>Math.round(x/70*100),bullishScore=normalize(bull),bearishScore=normalize(bear);
 const mandatoryBuy=sweepLow&&bosUp&&bullDisp&&!!bullOB?.fresh&&bullFvgs.length>0,mandatorySell=sweepHigh&&bosDown&&bearDisp&&!!bearOB?.fresh&&bearFvgs.length>0;
 return{bullishScore,bearishScore,mandatoryBuy,mandatorySell,features:{bosUp,bosDown,sweepLow,sweepHigh,bullDisp,bearDisp,bullFvg:bullFvgs.length>0,bearFvg:bearFvgs.length>0,bullOB,bearOB,bullRetest,bearRetest,h1Bull,h1Bear},zones:{bullFvgs,bearFvgs},range:{high:Math.max(...c.map(x=>x.high)),low:Math.min(...c.map(x=>x.low))}};
}

export function analyzeRollingM5(candles,h1Context={}){
 if(!Array.isArray(candles)||candles.length<12)throw new Error("At least 12 closed M5 candles required");
 const raw=candles.slice(-12).map(x=>({...x,time:new Date(x.time),open:+x.open,high:+x.high,low:+x.low,close:+x.close}));
 if(raw.some(x=>Number.isNaN(x.time.getTime())||![x.open,x.high,x.low,x.close].every(Number.isFinite)))throw new Error("Invalid rolling M5 OHLC/time");
 raw.sort((a,b)=>a.time-b.time);
 for(let i=1;i<raw.length;i++)if(raw[i].time-raw[i-1].time!==300000)throw new Error("Rolling M5 candles must be contiguous");
 const base=raw[0].time;
 const normalized=raw.map((x,i)=>({...x,time:new Date(Date.UTC(base.getUTCFullYear(),base.getUTCMonth(),base.getUTCDate(),base.getUTCHours(),i*5,0))}));
 const result=analyzeSMC(normalized,h1Context);
 result.sourceWindow={mode:"ROLLING_12_M5",from:raw[0].time.toISOString(),to:raw.at(-1).time.toISOString()};
 return result;
}
