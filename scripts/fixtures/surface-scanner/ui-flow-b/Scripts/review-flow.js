function submitReview() {
  $.ajax({
    type: 'POST',
    url: '/Review/Validate',
    success: function () {
      $.post('/Review/Submit');
    }
  });
}

$('#btnReview').click(function () {
  submitReview();
});

$(document).on('click', '#btnAlternative', function () {
  $.ajax({ method: 'POST', url: '/Alternative/Validate' });
});

document.getElementById('btnDynamic').addEventListener('click', function () {
  const destination = window.dynamicEndpoint;
  fetch(destination, { method: 'POST' });
});

$('#btnCloseModal').click(function () {
  $('#dialog').hide();
});
