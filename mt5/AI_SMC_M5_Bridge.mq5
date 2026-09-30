#property strict
#property version "1.40"
input string ApiUrl="https://smc-scalping-ai-production.up.railway.app/api/m5/candle";
input string HeartbeatUrl="https://smc-scalping-ai-production.up.railway.app/api/mt5/heartbeat";
input string MtfUrl="https://smc-scalping-ai-production.up.railway.app/api/mtf/analyze";
input string ApiSymbol="XAUUSD";
input int BrokerUtcOffsetHours=0;
input int TimeoutMs=10000;
datetime lastSent=0;
datetime lastHeartbeat=0;

string IsoUtc(datetime brokerTime){datetime u=brokerTime-BrokerUtcOffsetHours*3600;MqlDateTime d;TimeToStruct(u,d);return StringFormat("%04d-%02d-%02dT%02d:%02d:00Z",d.year,d.mon,d.day,d.hour,d.min);}
string JsonCandle(MqlRates &r){return StringFormat("{\"symbol\":\"%s\",\"candle\":{\"time\":\"%s\",\"open\":%.5f,\"high\":%.5f,\"low\":%.5f,\"close\":%.5f,\"tickVolume\":%I64d,\"closed\":true}}",ApiSymbol,IsoUtc(r.time),r.open,r.high,r.low,r.close,r.tick_volume);}
bool SendRate(MqlRates &r){string body=JsonCandle(r),headers="Content-Type: application/json\r\n",respHeaders;char data[],result[];StringToCharArray(body,data,0,WHOLE_ARRAY,CP_UTF8);if(ArraySize(data)>0)ArrayResize(data,ArraySize(data)-1);ResetLastError();int code=WebRequest("POST",ApiUrl,headers,TimeoutMs,data,result,respHeaders);if(code<0){Print("SMC Bridge WebRequest failed=",GetLastError());return false;}Print("SMC Bridge HTTP ",code," | ",CharArrayToString(result,0,-1,CP_UTF8));if(code>=200&&code<300){lastSent=r.time;return true;}return false;}

bool BackfillCurrentH1(){
 MqlRates current[];ArraySetAsSeries(current,true);
 if(CopyRates(_Symbol,PERIOD_M5,0,1,current)!=1)return false;
 MqlDateTime d;TimeToStruct(current[0].time,d);int currentMinute=d.min;
 int closedCount=currentMinute/5;
 if(closedCount<=0)return true;
 MqlRates rates[];ArraySetAsSeries(rates,false);
 if(CopyRates(_Symbol,PERIOD_M5,1,closedCount,rates)!=closedCount){Print("SMC Bridge backfill CopyRates failed ",GetLastError());return false;}
 for(int i=0;i<ArraySize(rates);i++){MqlDateTime x;TimeToStruct(rates[i].time,x);if(x.hour==d.hour&&rates[i].time<current[0].time){if(!SendRate(rates[i]))return false;}}
 return true;
}

bool SendHeartbeat(){string headers="Content-Type: application/json\r\n",respHeaders;char data[],result[];string body="{\"symbol\":\""+ApiSymbol+"\"}";StringToCharArray(body,data,0,WHOLE_ARRAY,CP_UTF8);if(ArraySize(data)>0)ArrayResize(data,ArraySize(data)-1);ResetLastError();int code=WebRequest("POST",HeartbeatUrl,headers,TimeoutMs,data,result,respHeaders);string resp=CharArrayToString(result,0,-1,CP_UTF8);if(code>=200&&code<300){lastHeartbeat=TimeLocal();Print("SMC Heartbeat ONLINE | HTTP ",code," | ",resp);if(StringFind(resp,"\"resyncRequired\":true")>=0){Print("SMC Bridge RESYNC requested by server");BackfillCurrentH1();}return true;}Print("SMC Heartbeat failed HTTP=",code," err=",GetLastError()," | ",resp);return false;}
string CandleObject(MqlRates &r){return StringFormat("{\"time\":\"%s\",\"open\":%.5f,\"high\":%.5f,\"low\":%.5f,\"close\":%.5f,\"tickVolume\":%I64d,\"closed\":true}",IsoUtc(r.time),r.open,r.high,r.low,r.close,r.tick_volume);}
string RatesJson(ENUM_TIMEFRAMES tf,int count){MqlRates r[];ArraySetAsSeries(r,false);int n=CopyRates(_Symbol,tf,1,count,r);if(n<=0)return "[]";string out="[";for(int i=0;i<n;i++){if(i>0)out+=",";out+=CandleObject(r[i]);}return out+"]";}
bool SendMTFAnalysis(){
 MqlRates d1[];ArraySetAsSeries(d1,true);if(CopyRates(_Symbol,PERIOD_D1,1,1,d1)!=1){Print("MTF D1 CopyRates failed");return false;}
 string body="{\"symbol\":\""+ApiSymbol+"\",\"previousD1\":"+CandleObject(d1[0])+",\"h1\":"+RatesJson(PERIOD_H1,24)+",\"m15\":"+RatesJson(PERIOD_M15,32)+",\"m5\":"+RatesJson(PERIOD_M5,36)+"}";
 string headers="Content-Type: application/json\r\n",respHeaders;char data[],result[];StringToCharArray(body,data,0,WHOLE_ARRAY,CP_UTF8);if(ArraySize(data)>0)ArrayResize(data,ArraySize(data)-1);
 ResetLastError();int code=WebRequest("POST",MtfUrl,headers,TimeoutMs,data,result,respHeaders);string resp=CharArrayToString(result,0,-1,CP_UTF8);
 Print("SMC MTF HTTP ",code," | ",resp);return code>=200&&code<300;
}
bool SendLatestClosed(){MqlRates r[];ArraySetAsSeries(r,true);if(CopyRates(_Symbol,PERIOD_M5,1,1,r)!=1)return false;if(r[0].time==lastSent)return true;return SendRate(r[0]);}
int OnInit(){EventSetTimer(2);Print("AI SMC MTF Bridge V1.40 | D1 bias + H1/M15/M5 | chart=",_Symbol);BackfillCurrentH1();return INIT_SUCCEEDED;}
void OnDeinit(const int reason){EventKillTimer();}
void OnTimer(){if(lastHeartbeat==0||TimeLocal()-lastHeartbeat>=60)SendHeartbeat();static datetime current=0;datetime t=iTime(_Symbol,PERIOD_M5,0);if(t>0&&t!=current){current=t;SendLatestClosed();SendMTFAnalysis();}}
void OnTick(){}
