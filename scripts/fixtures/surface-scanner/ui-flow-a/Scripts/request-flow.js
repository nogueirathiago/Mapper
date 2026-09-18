$('#btnSendRequest').on('click', function () {
  $.ajax({ method: 'GET', url: '/Requests/ValidateSend' })
    .done(function (html) { $('#dialog').html(html); });
});
