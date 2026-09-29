#property strict
#property version "1.10"
input string ApiUrl="https://smc-scalping-ai-production.up.railway.app/api/m5/candle";
input string ApiSymbol="XAUUSD";
input int BrokerUtcOffsetHours=0; // set to broker server UTC offset
input int TimeoutMs=10000;
datetime lastSent=0;
string IsoUtc(datetime brokerTime){datetime u=brokerTime-BrokerUtcOffsetHours*3600;MqlDateTime d;TimeToStruct(u,d);return StringFormat("%04d-%02d-%02dT%02d:%02d:00Z",d.year,d.mon,d.day,d.hour,d.min);}
string JsonCandle(MqlRates &r){return StringFormat("{\"symbol\":\"%s\",\"candle\":{\"time\":\"%s\",\"open\":%.5f,\"high\":%.5f,\"low\":%.5f,\"close\":%.5f,\"tickVolume\":%I64d,\"closed\":true}}",ApiSymbol,IsoUtc(r.time),r.open,r.high,r.low,r.close,r.tick_volume);}
bool SendClosedM5(){MqlRates r[];ArraySetAsSeries(r,true);if(CopyRates(_Symbol,PERIOD_M5,1,1,r)!=1){Print("SMC Bridge: CopyRates failed ",GetLastError());return false;}if(r[0].time==lastSent)return true;string body=JsonCandle(r[0]),headers="Content-Type: application/json\r\n",respHeaders;char data[],result[];StringToCharArray(body,data,0,WHOLE_ARRAY,CP_UTF8);if(ArraySize(data)>0)ArrayResize(data,ArraySize(data)-1);ResetLastError();int code=WebRequest("POST",ApiUrl,headers,TimeoutMs,data,result,respHeaders);if(code<0){Print("SMC Bridge WebRequest failed=",GetLastError()," | Allow URL in Tools > Options > Expert Advisors");return false;}string response=CharArrayToString(result,0,-1,CP_UTF8);Print("SMC Bridge HTTP ",code," | ",response);if(code>=200&&code<300){lastSent=r[0].time;return true;}return false;}
int OnInit(){EventSetTimer(2);Print("AI SMC M5 Bridge started | chart=",_Symbol," API symbol=",ApiSymbol," UTC offset=",BrokerUtcOffsetHours);return INIT_SUCCEEDED;}
void OnDeinit(const int reason){EventKillTimer();}
void OnTimer(){static datetime current=0;datetime t=iTime(_Symbol,PERIOD_M5,0);if(t>0&&t!=current){current=t;SendClosedM5();}}
void OnTick(){}
