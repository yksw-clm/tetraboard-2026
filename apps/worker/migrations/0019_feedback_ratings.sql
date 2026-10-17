ALTER TABLE feedback ADD COLUMN rating INTEGER CHECK (rating BETWEEN 1 AND 5);
ALTER TABLE feedback ADD COLUMN opponent TEXT CHECK (opponent IN ('cpu', 'human'));
