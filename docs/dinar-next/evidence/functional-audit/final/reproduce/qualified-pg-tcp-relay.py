"""Private Unix listeners forward only to approved loopback PostgreSQL16/18 TCP ports."""
from pathlib import Path
import asyncio,os,signal,json
root=Path('/workspace/dinar-connect-evidence/qualified-pg-relay-0c68334');root.mkdir(mode=0o700,exist_ok=True);root.chmod(0o700)
async def relay(reader,writer,port):
 try:
  backend,remote=await asyncio.open_connection('127.0.0.1',port)
  async def pipe(r,w):
   try:
    while data:=await r.read(65536):w.write(data);await w.drain()
   finally:w.close()
  await asyncio.gather(pipe(reader,remote),pipe(backend,writer),return_exceptions=True)
 except Exception:writer.close()
async def main():
 stop=asyncio.Event();loop=asyncio.get_running_loop()
 for sig in [signal.SIGINT,signal.SIGTERM]:loop.add_signal_handler(sig,stop.set)
 servers=[];paths=[]
 try:
  for pg,port in [(16,55416),(18,55433)]:
   path=root/f'pg{pg}.sock';assert not path.exists(),'Refusing to replace an existing relay socket'
   servers.append(await asyncio.start_unix_server(lambda r,w,p=port:relay(r,w,p),str(path)));path.chmod(0o600);paths.append(path)
  print(json.dumps({'state':'READY','pid':os.getpid(),'unixSocketPermissions':'0600','targetTCP':'127.0.0.1 only','ports':[55416,55433],'trafficLogging':False}),flush=True)
  await stop.wait()
 finally:
  for server in servers:server.close();await server.wait_closed()
  for path in paths:path.unlink(missing_ok=True)
asyncio.run(main())
