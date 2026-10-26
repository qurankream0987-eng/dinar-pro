import express from 'express';
import path from 'node:path';
import app from '../src/app';
const root = path.resolve('../dinar/dist/public');
app.use(express.static(root));
app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'index.html')));
const port = Number(process.env.QA_PORT ?? 4173);
app.listen(port, '127.0.0.1', () => console.log(`Visual QA server: http://127.0.0.1:${port}`));
