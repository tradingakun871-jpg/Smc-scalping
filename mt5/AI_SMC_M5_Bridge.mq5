#property strict
#property version "1.30"
input string ApiUrl="https://smc-scalping-ai-production.up.railway.app/api/m5/candle";
input string HeartbeatUrl="https://smc-scalping-ai-production.up.railway.app/api/mt5/heartbeat";
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

bool SendHeartbeat(){string headers="Content-Type: application/json\\r\\n",respHeaders;char data[],result[];string body="{\\\"symbol\\\":\\\""+ApiSymbol+"\\\"}";StringToCharArray(body,data,0,WHOLE_ARRAY,CP_UTF8);if(ArraySize(data)>0)ArrayResize(data,ArraySize(data)-1);ResetLastError();int code=WebRequest("POST",HeartbeatUrl,headers,TimeoutMs,data,result,respHeaders);if(code>=200&&code<300){lastHeartbeat=TimeLocal();return true;}Print("SMC Heartbeat failed HTTP=",code," err=",GetLastError());return false;}
bool SendLatestClosed(){MqlRates r[];ArraySetAsSeries(r,true);if(CopyRates(_Symbol,PERIOD_M5,1,1,r)!=1)return false;if(r[0].time==lastSent)return true;return SendRate(r[0]);}
int OnInit(){EventSetTimer(2);Print("AI SMC M5 Bridge V1.30 | backfill active H1 | chart=",_Symbol);BackfillCurrentH1();return INIT_SUCCEEDED;}
void OnDeinit(const int reason){EventKillTimer();}
void OnTimer(){if(lastHeartbeat==0||TimeLocal()-lastHeartbeat>=60)SendHeartbeat();static datetime current=0;datetime t=iTime(_Symbol,PERIOD_M5,0);if(t>0&&t!=current){current=t;SendLatestClosed();}}
void OnTick(){}
