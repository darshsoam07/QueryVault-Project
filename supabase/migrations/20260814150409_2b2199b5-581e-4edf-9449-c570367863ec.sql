REVOKE ALL ON public.worker_credentials FROM authenticated, anon, PUBLIC;
GRANT ALL ON public.worker_credentials TO service_role;