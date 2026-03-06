import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(() => "success-toast"),
    error: vi.fn(() => "error-toast"),
    info: vi.fn(() => "info-toast"),
    loading: vi.fn(() => "loading-toast"),
    dismiss: vi.fn(() => "dismissed"),
    promise: vi.fn(() => "promise-toast"),
  },
}));

describe("notify", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses the key as toast id for deduplication", async () => {
    const { notify } = await import("./notify");

    notify.error("Lecture impossible", { key: "media:track-1" });
    notify.error("Lecture impossible", { key: "media:track-1" });

    const toastError = toast.error as ReturnType<typeof vi.fn>;

    expect(toastError).toHaveBeenCalledTimes(2);
    expect(toastError).toHaveBeenNthCalledWith(
      1,
      "Lecture impossible",
      expect.objectContaining({ id: "media:track-1" }),
    );
    expect(toastError).toHaveBeenNthCalledWith(
      2,
      "Lecture impossible",
      expect.objectContaining({ id: "media:track-1" }),
    );
  });

  it("forwards dismiss by id or key", async () => {
    const { notify } = await import("./notify");

    notify.dismiss("room:error");

    const toastDismiss = toast.dismiss as ReturnType<typeof vi.fn>;

    expect(toastDismiss).toHaveBeenCalledWith("room:error");
  });
});
