document.addEventListener("click", function (e) {
  var btn = e.target.closest('[data-toggle="password"]');
  if (!btn) return;
  var input = document.getElementById("password");
  if (!input) return;
  var shown = input.type === "text";
  input.type = shown ? "password" : "text";
  btn.setAttribute("data-shown", shown ? "false" : "true");
  btn.setAttribute(
    "aria-label",
    shown ? btn.dataset.labelShow : btn.dataset.labelHide
  );
});
