import { toast, type ExternalToast } from "sonner";

type NotifyOptions = ExternalToast & {
  key?: string;
};

type NotifyPromiseLabels<T> = {
  loading?: string;
  success?: string | ((value: T) => string);
  error?: string | ((error: unknown) => string);
  description?: string;
};

function withToastId(options?: NotifyOptions): ExternalToast | undefined {
  if (!options) return undefined;
  const { key, id, ...rest } = options;
  return {
    ...rest,
    id: key ?? id,
  };
}

function withDefaultDuration(options: NotifyOptions | undefined, duration: number) {
  return {
    duration,
    ...withToastId(options),
  } satisfies ExternalToast;
}

export const notify = {
  success(message: string, options?: NotifyOptions) {
    return toast.success(message, withDefaultDuration(options, 2_600));
  },

  error(message: string, options?: NotifyOptions) {
    return toast.error(message, withDefaultDuration(options, 4_500));
  },

  info(message: string, options?: NotifyOptions) {
    return toast.info(message, withDefaultDuration(options, 3_400));
  },

  loading(message: string, options?: NotifyOptions) {
    return toast.loading(message, withToastId(options));
  },

  promise<T>(
    promise: Promise<T> | (() => Promise<T>),
    labels: NotifyPromiseLabels<T>,
    options?: NotifyOptions,
  ) {
    return toast.promise(promise, {
      loading: labels.loading,
      success: (value) =>
        typeof labels.success === "function"
          ? labels.success(value)
          : (labels.success ?? "Terminé."),
      error: (error) =>
        typeof labels.error === "function"
          ? labels.error(error)
          : (labels.error ?? "Une erreur est survenue."),
      description: labels.description,
      ...withToastId(options),
    });
  },

  dismiss(idOrKey?: string | number) {
    return toast.dismiss(idOrKey);
  },
};
