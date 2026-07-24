const fs = require('fs');
let code = fs.readFileSync('c:/python/app.js', 'utf8');

const anchor1 = 'data.nonStudySessions.forEach(ns => {';
const firstAnchor1 = code.indexOf(anchor1);

const anchor2 = '        if(!nonStudySessions.find(s => s.id === ns.id && s.ts === ns.ts)) {';
// The second occurrence of anchor2 is where PART D starts.
let firstAnchor2 = code.indexOf(anchor2);
let secondAnchor2 = code.indexOf(anchor2, firstAnchor2 + 1);

const partA = code.substring(0, firstAnchor1 + anchor1.length);
const partD = code.substring(secondAnchor2);

fs.writeFileSync('c:/python/app.js', partA + '\n' + partD);
console.log('Fixed duplication!');
