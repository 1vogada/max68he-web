// child_process for the browser build: a page can't start programs.
const no = () => { throw Object.assign(new Error('This needs the desktop app (a web page cannot run programs).'), { status: 501 }); };
module.exports = { spawn: no, execFile: no, execFileSync: no, exec: no, execSync: no };
