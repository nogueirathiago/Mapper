using System.Web.Mvc;

public class WorkflowController : Controller
{
    [HttpGet]
    public ActionResult Check(int id)
    {
        if (id < 0) return PartialView("_WorkflowBlocked");
        return Json(new { success = true }, JsonRequestBehavior.AllowGet);
    }

    [HttpGet]
    public ActionResult Validate(int id)
        => PartialView("_WorkflowConfirmation");

    [HttpPost]
    public JsonResult Complete(int id)
        => Json(new { success = true });
}
