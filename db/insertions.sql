INSERT INTO streets (name, neighborhood, descr) VALUES
    ('Avenida Jornalista Rubens de Arruda Ramos', 'Centro', 'Beira Mar Norte')    
ON CONFLICT (name) DO NOTHING;