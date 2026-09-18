using System.Web.Mvc;

public abstract class PortalController : Controller
{
}

public class RequestsController : PortalController
{
    [HttpGet]
    [Route("requests/{id}")]
    public ActionResult Detail(int id) => View();

    [HttpPost]
    public ActionResult ValidateSend(int id)
        => PartialView("_ConfirmSend");

    [NonAction]
    public bool PublicHelper(int id) => id > 0;

    public static string StaticHelper(int id) => id.ToString();

    private bool InternalCheck(int id) => id > 0;
}

public class RecordsController : PortalController
{
    public ActionResult Lookup(int id) => View();

    public ActionResult Lookup(string key) => View();
}
