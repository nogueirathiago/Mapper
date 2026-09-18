using System.Web.Mvc;

public class RequestsController : Controller
{
    [HttpGet]
    public ActionResult ValidateSend(int id)
        => PartialView("_ConfirmSend");
}
