"""Run supported local suites in an actual no-route namespace; PG transport uses existing local Unix sockets."""
import asyncio,sys,subprocess,os
async def relay(reader,writer,socket):
 try:
  peer,remote=await asyncio.open_unix_connection(socket)
  async def pipe(r,w):
   try:
    while data:=await r.read(65536):w.write(data);await w.drain()
   finally:w.close()
  await asyncio.gather(pipe(reader,remote),pipe(peer,writer),return_exceptions=True)
 except Exception:writer.close()
async def main():
 subprocess.run(['ip','link','set','lo','up'],check=True)
 subprocess.run(['ip','link','add','dinar-test0','type','veth','peer','name','dinar-test1'],check=True)
 subprocess.run(['ip','addr','add','198.18.0.1/32','dev','dinar-test0'],check=True)
 for interface in ['dinar-test0','dinar-test1']:subprocess.run(['ip','link','set',interface,'up'],check=True)
 assert not subprocess.check_output(['ip','route','show','default']).strip()
 assert not subprocess.check_output(['ip','-6','route','show','default']).strip()

 servers=[]
 for port,socket in [(55416,'/workspace/dinar-connect-evidence/qualified-pg-relay-0c68334/pg16.sock'),(55433,'/workspace/dinar-connect-evidence/qualified-pg-relay-0c68334/pg18.sock')]:
  if not os.path.exists(socket):raise RuntimeError('Approved local PG socket unavailable: '+socket)
  servers.append(await asyncio.start_server(lambda r,w,s=socket:relay(r,w,s),'127.0.0.1',port))
 print('QUALIFIED_NAMESPACE loopback plus address-only isolated veth /32; no default/external routes; canonical wrappers unchanged; PG16/18 via private Unix relays to real loopback TCP; inet identity preserved',flush=True)
 p=await asyncio.create_subprocess_exec(*sys.argv[1:]);code=await p.wait()
 for server in servers:server.close();await server.wait_closed()
 return code
raise SystemExit(asyncio.run(main()))
