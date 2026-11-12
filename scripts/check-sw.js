#!/usr/bin/env node
/* 배포 전 점검: 서비스워커가 비어 있지 않은지, 캐시 목록이 실제 파일과 맞는지 확인한다.
   사용: node scripts/check-sw.js   (실패하면 종료 코드 1) */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const fail = m => { console.error('✗ ' + m); process.exitCode = 1; };
const ok = m => console.log('✓ ' + m);

const swText = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
if (swText.trim().length < 200) fail(`sw.js 가 비어 있거나 너무 짧습니다 (${swText.length} bytes)`);
else ok(`sw.js 크기 ${swText.length} bytes`);

try { new Function(swText); ok('sw.js 문법 정상'); } catch (e) { fail('sw.js 문법 오류: ' + e.message); }

const ver = swText.match(/const VERSION = '([^']+)'/);
ver ? ok(`캐시 버전 ${ver[1]}`) : fail('sw.js 에서 VERSION 을 찾을 수 없습니다');

const shell = (swText.match(/const SHELL = \[([\s\S]*?)\];/) || [])[1];
if (!shell) fail('sw.js 에서 SHELL 목록을 찾을 수 없습니다');
else {
  const files = [...shell.matchAll(/'([^']+)'/g)].map(m => m[1]).filter(f => f !== './');
  const missing = files.filter(f => !fs.existsSync(path.join(root, f)));
  missing.length ? fail('캐시 목록에 있지만 파일이 없음: ' + missing.join(', ')) : ok(`캐시 목록 ${files.length}개 파일 모두 존재`);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const used = [...html.matchAll(/(?:src|href)="([^"#?]+)"/g)].map(m => m[1]).filter(u => !/^(https?:)?\/\//.test(u));
  const uncached = used.filter(u => !files.includes(u));
  uncached.length ? fail('index.html 이 쓰지만 캐시 목록에 없음(오프라인에서 깨짐): ' + uncached.join(', ')) : ok('index.html 이 쓰는 파일이 모두 캐시 목록에 있음');
}
