---
name: Bug report
about: Create a report to help us improve

---

**Describe the bug**

A clear and concise description of what the bug is.

**Versions (please complete the following information):**
 - Chokidar version [e.g. 3.2.1 or commit hash]
 - Node version [e.g. 12.11.0, ensure you are using the latest node.js]
 - OS version: [e.g. Ubuntu 19.04 or MacOS 10.15 or Windows 10]

**To Reproduce:**

Steps to reproduce the behavior. Include filename and chokidar config.

Ideally prove a problem by isolating and making it reproducible with a very short sample program, which you could paste here:

```
const chokidar = require('chokidar');
const fs = require('fs');
// One-liner for files and directories starting with 'test'
chokidar.watch('test*', {}).on('all', (event, path) => {
  console.log(event, path);
});
fs.writeFileSync('test.txt', 'testing 1');
// In a comment describe expected output versus observed problem
```

Most valuable could be one or more test cases for [test.js](https://github.com/paulmillr/chokidar/blob/master/test.js) to demonstrate the problem.

**Expected behavior**
A clear and concise description of what you expect to happen.

**Additional context**
Add any other context about the problem here.
Optionally nice to know what project you are working on.
