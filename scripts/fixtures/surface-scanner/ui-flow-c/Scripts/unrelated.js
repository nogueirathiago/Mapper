$('#btnOpenWorkflow').click(function () {
  $.ajax({ method: 'POST', url: '/Other/Open' });
});
