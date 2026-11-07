"""Reuse canonical HTTPS provider-navigation fixture; never call a real provider."""
from pathlib import Path
from contextlib import contextmanager
import subprocess,os,tempfile,time,base64,shutil,json
@contextmanager
def local_navigation_fixture(dest,api,path):
 work=Path(tempfile.mkdtemp(prefix='dinar-expanded-navigation-',dir='/tmp'));log=dest/'provider-navigation.log';log.write_text('');stdout=dest/'provider-navigation-process.log';pidfile=work/'pid';process=None
 clean={'PATH':path,'HOME':str(work),'LANG':'C.UTF-8','TZ':'UTC','NODE_OPTIONS':''}
 try:
  subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=local-suite-third-party','-addext','subjectAltName=DNS:fonts.googleapis.com,DNS:fonts.gstatic.com,DNS:dash.cloudflare.com,DNS:browser.catalog.partner.example','-keyout',str(work/'stub.key'),'-out',str(work/'stub.crt')],env=clean,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
  public=subprocess.check_output(['openssl','x509','-in',str(work/'stub.crt'),'-pubkey','-noout'],env=clean);der=subprocess.check_output(['openssl','pkey','-pubin','-outform','der'],input=public,env=clean,stderr=subprocess.DEVNULL)
  import hashlib
  spki=base64.b64encode(hashlib.sha256(der).digest()).decode();node=shutil.which('node',path=path);stub=api/'test/isolation/third-party-stub.mjs'
  # Reuse the canonical TLS response fixture on an unprivileged loopback port.
  # Chromium resolver rules map only the exact public fixture hosts to this port.
  import socket
  with socket.socket() as reservation:
   reservation.bind(('127.0.0.1',0)); local_port=reservation.getsockname()[1]
  with stdout.open('w') as stream:
   process=subprocess.Popen([node,str(stub),str(work/'stub.crt'),str(work/'stub.key'),str(local_port),str(log)],env=clean,stdout=stream,stderr=subprocess.STDOUT)
  for _ in range(60):
   if 'THIRD_PARTY_STUB: listening' in stdout.read_text():break
   if process.poll() is not None:raise RuntimeError('Canonical local HTTPS fixture failed; see retained log')
   time.sleep(.1)
  else:raise RuntimeError('Canonical local HTTPS fixture did not become ready')
  wrapper=work/'chromium';wrapper.write_text('#!/bin/sh\nexec /usr/bin/chromium --host-resolver-rules="MAP fonts.googleapis.com 127.0.0.1:'+str(local_port)+', MAP fonts.gstatic.com 127.0.0.1:'+str(local_port)+', MAP dash.cloudflare.com 127.0.0.1:'+str(local_port)+', MAP browser.catalog.partner.example 127.0.0.1:'+str(local_port)+'" --ignore-certificate-errors-spki-list="'+spki+'" "$@"\n');wrapper.chmod(0o700)
  yield {'CHROMIUM_PATH':str(wrapper),'DINAR_CHROMIUM':str(wrapper),'REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE':str(wrapper),'DINAR_SUPPLEMENTAL_PROVIDER_TLS_PORT':str(local_port),'DINAR_SUPPLEMENTAL_PROVIDER_TLS_CA':str(work/'stub.crt')}
 finally:
  if process:
   if process.poll() is None:process.terminate()
   try:process.wait(timeout=5)
   except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
  shutil.rmtree(work)
  if log.exists():
   for line in log.read_text().splitlines():assert json.loads(line)['host'] in ['fonts.googleapis.com','fonts.gstatic.com','dash.cloudflare.com','browser.catalog.partner.example']
