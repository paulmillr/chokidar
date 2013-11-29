require('./').watch('lib', {ignored: /[\/\\]\./}).on('all', function(event, path) {
  console.log(event, path);
});
