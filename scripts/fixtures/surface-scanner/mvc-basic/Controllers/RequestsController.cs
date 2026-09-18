using System.Web.Mvc;

public class RequestsController : Controller
{
    [HttpGet]
    [Route("requests/{id}")]
    public ActionResult Detail(int id) => View();

    [HttpPost]
    public ActionResult ValidateSend(int id)
        => PartialView("_ConfirmSend");

    [NonAction]
    public bool PublicHelper(int id) => id > 0;

    private bool InternalCheck(int id) => id > 0;
}
